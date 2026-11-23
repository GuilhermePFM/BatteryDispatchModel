MODEL   := docs/model/model.md
HTML    := docs/model/model.html
PDF     := docs/model/model.pdf

## The tracked copy of the PDF, refreshed by `make pdf`
TRACKED_PDF := docs/model/battery-dispatch.pdf

LATEX_DIR  := docs/model/latex

## Image paths in the notes are relative to the note, as GitHub reads them;
## pandoc resolves them against the working directory unless told otherwise.
RESOURCES    := --resource-path=docs/model
PANDOC_FLAGS := --standalone $(RESOURCES) --metadata pagetitle="Battery dispatch model"

## PDFs go through LaTeX as articles: pandoc's default template, a typographic
## preamble, and a Lua filter that turns a Markdown note into an article body
## (drops the title heading and the manual section numbers, which LaTeX then
## assigns itself, so the "§4.2" references in the prose still match).
## Use a Unicode mono font when the machine has one, for the code blocks.
MONOFONT := $(shell fc-list : family 2>/dev/null | tr ',' '\n' | grep -ixm1 'Noto Sans Mono')
MONO_OPT := $(if $(MONOFONT),-V monofont="$(MONOFONT)")

ARTICLE_DEPS := $(LATEX_DIR)/common.yaml $(LATEX_DIR)/preamble.tex $(LATEX_DIR)/article.lua
PANDOC_ARTICLE := pandoc --standalone --pdf-engine=tectonic $(RESOURCES) \
	--metadata-file=$(LATEX_DIR)/common.yaml \
	--include-in-header=$(LATEX_DIR)/preamble.tex \
	--lua-filter=$(LATEX_DIR)/article.lua \
	--metadata date="$(shell LC_ALL=C date +'%e %B %Y' | sed 's/^ //')" \
	$(MONO_OPT)

.PHONY: docker docker-shell docker-test html preview pdf clean-docs

## Run the model in Docker: same pinned environment on any machine, results
## written to data/results on the host. Extra arguments pass through, e.g.
## `make docker ARGS="dispatch --start 2025-02-01 --end 2026-01-31"`.
ARGS ?=

docker:
	scripts/docker-run.sh $(ARGS)

docker-shell:
	DEV=1 scripts/docker-run.sh --shell

## The test suite inside the image, which is what "it runs anywhere" means.
## The cache goes to /tmp: /app belongs to root, and the run does not.
docker-test:
	DEV=1 scripts/docker-run.sh --shell -c "pytest -o cache_dir=/tmp/pytest_cache"

## Render the model doc to HTML (MathJax, same engine GitHub uses)
html: $(HTML)

$(HTML): $(MODEL)
	pandoc $< -o $@ $(PANDOC_FLAGS) --mathjax

## Render and open in the browser; afterwards `make html` + refresh is enough
## setsid -f detaches the viewer: xdg-open blocks until the browser exits, and
## a bare `&` would be killed when the task shell tears down its process group.
preview: $(HTML)
	setsid -f xdg-open "$(abspath $(HTML))"

## Export a PDF, typeset as a LaTeX article (requires tectonic), and refresh
## the copy the repository tracks
pdf: $(TRACKED_PDF)

$(PDF): $(MODEL) $(ARTICLE_DEPS) docs/model/latex/model.yaml
	$(PANDOC_ARTICLE) --metadata-file=docs/model/latex/model.yaml $< -o $@

$(TRACKED_PDF): $(PDF)
	cp $< $@

clean-docs:
	rm -f $(HTML) $(PDF)

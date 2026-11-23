# The solver Lambda: the package, its locked dependencies, the bundled prices
# and the handler, on AWS's Python base image. Build from the repo root:
#
#   docker buildx build --platform linux/arm64 -f services/solver/Dockerfile -t batteryplan-solver --load .
#
# The default target is the Lambda image. `--target local` is the same image
# running local_worker.py, which polls LocalStack's queue (docker-compose.yml).
FROM public.ecr.aws/lambda/python:3.12 AS base

# matplotlib, a dependency of the package, wants a writable config dir; /tmp is
# the only writable path on Lambda.
ENV MPLCONFIGDIR=/tmp/matplotlib \
    PLD_CSV=${LAMBDA_TASK_ROOT}/data/pld_hourly.csv \
    CONTRACTS_DIR=${LAMBDA_TASK_ROOT}/contracts

# Dependencies from uv.lock: the package's own plus the `solver` group. boto3
# is left to the base image, which ships it. uv is mounted, not installed.
RUN --mount=from=ghcr.io/astral-sh/uv:0.13.4,source=/uv,target=/usr/local/bin/uv \
    --mount=type=bind,source=pyproject.toml,target=/tmp/build/pyproject.toml \
    --mount=type=bind,source=uv.lock,target=/tmp/build/uv.lock \
    cd /tmp/build \
    && uv export --frozen --no-dev --group solver --no-emit-project --no-hashes -o requirements.txt \
    && uv pip install --system --no-cache --compile-bytecode -r requirements.txt

# The package as source in the task root, next to the handler.
COPY src/battery_plan/ ${LAMBDA_TASK_ROOT}/battery_plan/
COPY data/raw/pld_hourly.csv ${LAMBDA_TASK_ROOT}/data/
COPY contracts/v2/*.schema.json ${LAMBDA_TASK_ROOT}/contracts/v2/
COPY services/solver/handler.py services/solver/local_worker.py ${LAMBDA_TASK_ROOT}/

FROM base AS local
ENTRYPOINT ["python", "local_worker.py"]

FROM base AS lambda
CMD ["handler.handler"]

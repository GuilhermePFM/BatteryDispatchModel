// Package prices handles uploaded price files: the presigned POST the browser
// uploads through, and a structural check of the file before a run is queued.
//
// The check mirrors battery_plan.data_io.load_market_prices_csv where it can,
// with messages in the same words, so a bad file is turned away at submission
// rather than as a failed run. The solver still reads the file in full and
// remains the judge.
package prices

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// MaxBytes is the largest upload accepted, the presigned POST's content-length-range.
const MaxBytes = 5 << 20

// MaxSpan is the longest stretch a file may cover: a run is at most 366
// calendar days, and a file a day longer than that leaves room either side.
const MaxSpan = 367 * 24 * time.Hour

const halfHour = 30 * time.Minute

// quoted is how many offending lines a message lists, as the Python loader does.
const quoted = 5

// FileError is a price file that cannot be used, explained for whoever supplied it.
type FileError struct{ Message string }

func (e *FileError) Error() string { return e.Message }

func fail(format string, args ...any) error { return &FileError{fmt.Sprintf(format, args...)} }

var columns = []string{"timestamp", "market_1", "market_2"}

type row struct {
	line   int // as a spreadsheet numbers it: the header is line 1
	raw    string
	at     time.Time
	m2     float64
	m2Text string
}

// Check reads a price file in the upload format of contracts/README.md.
func Check(data []byte) error {
	if len(data) > MaxBytes {
		return fail("The file is larger than %d MB.", MaxBytes>>20)
	}
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	if !utf8.Valid(data) {
		return fail("The file is not UTF-8 text.")
	}
	r := csv.NewReader(bytes.NewReader(data))
	r.FieldsPerRecord = -1
	r.TrimLeadingSpace = true

	header, err := r.Read()
	if err == io.EOF {
		return fail("The file is empty.")
	}
	if err != nil {
		return fail("The file is not readable as CSV: %v", err)
	}
	index := map[string]int{}
	for i, name := range header {
		name = strings.ToLower(strings.TrimSpace(name))
		if _, seen := index[name]; !seen {
			index[name] = i
		}
	}
	var missing []string
	for _, c := range columns {
		if _, ok := index[c]; !ok {
			missing = append(missing, c)
		}
	}
	if len(missing) > 0 {
		return fail("Missing column(s): %s. The header row must be: %s",
			strings.Join(missing, ", "), strings.Join(columns, ","))
	}

	var rows []row
	var badTime, badM1, badM2 []string
	for {
		record, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			var pe *csv.ParseError
			if errors.As(err, &pe) {
				return fail("The file is not readable as CSV: line %d: %v", pe.Line, pe.Err)
			}
			return fail("The file is not readable as CSV: %v", err)
		}
		if len(record) > len(header) {
			line, _ := r.FieldPos(0)
			return fail("The file is not readable as CSV: line %d has %d fields, the header %d.", line, len(record), len(header))
		}
		line, _ := r.FieldPos(0)
		cell := func(name string) string {
			if i := index[name]; i < len(record) {
				return record[i]
			}
			return ""
		}
		rw := row{line: line, raw: cell("timestamp"), m2Text: cell("market_2")}
		var ok bool
		if rw.at, ok = parseTimestamp(rw.raw); !ok {
			badTime = append(badTime, at(line, rw.raw))
		}
		if _, ok = parsePrice(cell("market_1")); !ok {
			badM1 = append(badM1, at(line, cell("market_1")))
		}
		if rw.m2, ok = parsePrice(rw.m2Text); !ok {
			badM2 = append(badM2, at(line, rw.m2Text))
		}
		rows = append(rows, rw)
		if len(rows) > int(MaxSpan/halfHour)+1 {
			return fail("The file covers more than %d days; a run spans at most 366, so trim it.", int(MaxSpan.Hours()/24))
		}
	}
	if len(rows) == 0 {
		return fail("The file has a header row but no prices.")
	}
	if len(badTime) > 0 {
		return fail("timestamp must be an ISO 8601 date and time (e.g. 2018-01-01T00:30:00); %s", see(badTime))
	}
	if len(badM1) > 0 {
		return fail("market_1 must be a number (£/MWh) in every row; %s", see(badM1))
	}
	if len(badM2) > 0 {
		return fail("market_2 must be a number (£/MWh) in every row; %s", see(badM2))
	}

	var offGrid []string
	for _, rw := range rows {
		if !rw.at.Equal(rw.at.Truncate(halfHour)) {
			offGrid = append(offGrid, at(rw.line, rw.raw))
		}
	}
	if len(offGrid) > 0 {
		return fail("Timestamps must fall on the hour or the half hour; %s", see(offGrid))
	}

	seen := map[time.Time]int{}
	for _, rw := range rows {
		seen[rw.at]++
	}
	var repeated []string
	count := 0
	for _, rw := range rows {
		if seen[rw.at] > 1 {
			repeated = append(repeated, at(rw.line, rw.raw))
		}
	}
	for _, n := range seen {
		if n > 1 {
			count += n - 1
		}
	}
	if count > 0 {
		return fail("%d duplicate timestamp(s); %s", count, see(repeated))
	}

	var back []string
	for i := 1; i < len(rows); i++ {
		if rows[i].at.Before(rows[i-1].at) {
			back = append(back, at(rows[i].line, rows[i].raw))
		}
	}
	if len(back) > 0 {
		return fail("Rows must be in time order; %s", see(back))
	}

	gaps, first := 0, 0
	for i := 1; i < len(rows); i++ {
		if rows[i].at.Sub(rows[i-1].at) != halfHour {
			if gaps == 0 {
				first = i
			}
			gaps++
		}
	}
	if gaps > 0 {
		more := ""
		if gaps > 1 {
			more = fmt.Sprintf(", and %d more gap(s)", gaps-1)
		}
		return fail("Timestamps must be consecutive half hours with no gaps; the file jumps from %s to %s (line %d to line %d)%s.",
			rows[first-1].raw, rows[first].raw, rows[first-1].line, rows[first].line, more)
	}

	firstAt, lastAt := rows[0].at, rows[len(rows)-1].at
	if firstAt.Minute() != 0 || lastAt.Minute() != 30 {
		return fail("The file must hold whole hours: start on the hour (e.g. 00:00) and end on the half hour (e.g. 23:30); it runs %s to %s.",
			firstAt.Format(time.DateTime), lastAt.Format(time.DateTime))
	}
	if lastAt.Sub(firstAt) >= MaxSpan {
		return fail("The file covers more than %d days; a run spans at most 366, so trim it.", int(MaxSpan.Hours()/24))
	}

	// Continuous and starting on the hour, so rows pair up into hours.
	var uneven []string
	for i := 0; i+1 < len(rows); i += 2 {
		if rows[i].m2 != rows[i+1].m2 {
			uneven = append(uneven, rows[i].at.Format("2006-01-02 15:04"))
		}
	}
	if len(uneven) > 0 {
		more := ""
		if len(uneven) > quoted {
			more = fmt.Sprintf(" and %d more", len(uneven)-quoted)
			uneven = uneven[:quoted]
		}
		return fail("market_2 is an hourly price and must be the same on both half hours of each hour; it differs in the hour(s) starting %s%s.",
			strings.Join(uneven, ", "), more)
	}
	return nil
}

func at(line int, cell string) string { return fmt.Sprintf("line %d (%s)", line, strconv.Quote(cell)) }

func see(lines []string) string {
	more := ""
	if len(lines) > quoted {
		more = fmt.Sprintf(" and %d more", len(lines)-quoted)
		lines = lines[:quoted]
	}
	return "see " + strings.Join(lines, ", ") + more + "."
}

func parsePrice(cell string) (float64, bool) {
	v, err := strconv.ParseFloat(strings.TrimSpace(cell), 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	return v, true
}

// The ISO 8601 shapes a price file is expected to use: a date, a T or a
// space, the time to the minute or second (with an optional fraction), and an
// optional Z or numeric offset; or the basic form, 20180101T003000. pandas
// reads a few rarer forms still.
var layouts = []string{
	"2006-01-02T15:04:05.999999999Z07:00",
	"2006-01-02T15:04:05.999999999Z0700",
	"2006-01-02T15:04:05.999999999",
	"2006-01-02T15:04Z07:00",
	"2006-01-02T15:04Z0700",
	"2006-01-02T15:04",
	"2006-01-02",
	"20060102T150405",
	"20060102T1504",
}

// parseTimestamp reads a timestamp as the loader does: an offset is
// converted to UTC and dropped, a naive time is taken as it is.
func parseTimestamp(cell string) (time.Time, bool) {
	s := strings.Replace(strings.TrimSpace(cell), " ", "T", 1)
	for _, layout := range layouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

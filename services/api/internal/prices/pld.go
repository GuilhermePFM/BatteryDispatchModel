package prices

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// pldHeader is the header row of an hourly PLD file.
const pldHeader = "hora,submercado,pld"

// pldSubmarkets counts the submarkets every hour must carry.
const pldSubmarkets = 4

// pldMessages is what each rejection tells the user, word for word the table
// in battery_plan.data_io.pld and web/src/lib/pld.ts.
var pldMessages = map[string]string{
	"encoding":     "The file is not UTF-8 text.",
	"empty":        "The file is empty.",
	"header":       "The header row must be: hora,submercado,pld",
	"no_rows":      "The file has a header row but no prices.",
	"fields":       "Every row must be: hora,submercado,pld",
	"timestamp":    "hora must be a local time as YYYY-MM-DDTHH:00.",
	"offset":       "hora must be local market time, with no UTC offset.",
	"off_hour":     "hora must fall on the hour.",
	"submarket":    "submercado must be SE, S, NE or N.",
	"price":        "pld must be a plain decimal number in BRL/MWh.",
	"non_positive": "pld must be greater than zero.",
	"duplicate":    "This hour and submercado already appear earlier in the file.",
	"order":        "Rows must be in time order.",
	"gap":          "Hours must be consecutive, with no gaps.",
	"incomplete":   "Each hour must have all four submercados.",
	"partial_day":  "The file must hold whole days, from 00:00 to 23:00.",
}

var (
	pldTimestamp  = regexp.MustCompile(`^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})$`)
	pldWithOffset = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$`)
	pldPrice      = regexp.MustCompile(`^-?[0-9]+(\.[0-9]+)?$`)
)

// PLDError is a PLD file that cannot be used, with a stable code and the line to fix.
type PLDError struct {
	Code string
	Line int
}

func (e *PLDError) Error() string {
	return fmt.Sprintf("line %d: %s", e.Line, pldMessages[e.Code])
}

type pldRow struct {
	hour      int64 // hours since the epoch, on the file's local clock
	submarket string
	line      int
}

// CheckPLD mirrors battery_plan.data_io.check_pld_csv: rows are read in order
// and the first bad one decides, then the checks across rows run. The shared
// cases are contracts/examples/pld-upload-verdicts.json.
func CheckPLD(data []byte) error {
	if !utf8.Valid(data) {
		return &PLDError{"encoding", 1}
	}
	text := string(bytes.TrimPrefix(data, []byte("\xef\xbb\xbf")))

	lines := strings.Split(text, "\n")
	for i := range lines {
		lines[i] = strings.TrimSuffix(lines[i], "\r")
	}
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) == 0 {
		return &PLDError{"empty", 1}
	}
	if lines[0] != pldHeader {
		return &PLDError{"header", 1}
	}
	if len(lines) == 1 {
		return &PLDError{"no_rows", 1}
	}

	rows := make([]pldRow, 0, len(lines)-1)
	for i, cell := range lines[1:] {
		rw, err := parsePLDRow(cell, i+2)
		if err != nil {
			return err
		}
		rows = append(rows, rw)
	}
	return checkPLDSeries(rows)
}

func parsePLDRow(text string, line int) (pldRow, error) {
	bad := func(code string) (pldRow, error) { return pldRow{}, &PLDError{code, line} }

	fields := strings.Split(text, ",")
	if len(fields) != 3 {
		return bad("fields")
	}
	hora, submarket, price := fields[0], fields[1], fields[2]

	if pldWithOffset.MatchString(hora) {
		return bad("offset")
	}
	m := pldTimestamp.FindStringSubmatch(hora)
	if m == nil {
		return bad("timestamp")
	}
	year, _ := strconv.Atoi(m[1])
	month, _ := strconv.Atoi(m[2])
	day, _ := strconv.Atoi(m[3])
	hour, _ := strconv.Atoi(m[4])
	minute, _ := strconv.Atoi(m[5])
	if year < 1900 || year > 2199 || hour > 23 || minute > 59 {
		return bad("timestamp")
	}
	// time.Date normalises 30 February into March; a changed day means it was not real.
	at := time.Date(year, time.Month(month), day, hour, minute, 0, 0, time.UTC)
	if int(at.Month()) != month || at.Day() != day {
		return bad("timestamp")
	}
	if minute != 0 {
		return bad("off_hour")
	}

	switch submarket {
	case "SE", "S", "NE", "N":
	default:
		return bad("submarket")
	}

	if !pldPrice.MatchString(price) {
		return bad("price")
	}
	value, err := strconv.ParseFloat(price, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return bad("price")
	}
	if math.IsInf(value, 0) || math.IsNaN(value) {
		return bad("price")
	}
	if value <= 0 {
		return bad("non_positive")
	}
	return pldRow{hour: at.Unix() / 3600, submarket: submarket, line: line}, nil
}

func checkPLDSeries(rows []pldRow) error {
	type key struct {
		hour      int64
		submarket string
	}
	seen := make(map[key]bool, len(rows))
	for _, rw := range rows {
		k := key{rw.hour, rw.submarket}
		if seen[k] {
			return &PLDError{"duplicate", rw.line}
		}
		seen[k] = true
	}

	for i := 1; i < len(rows); i++ {
		if rows[i].hour < rows[i-1].hour {
			return &PLDError{"order", rows[i].line}
		}
	}

	for start := 0; start < len(rows); {
		if start > 0 && rows[start].hour != rows[start-1].hour+1 {
			return &PLDError{"gap", rows[start].line}
		}
		end := start
		for end < len(rows) && rows[end].hour == rows[start].hour {
			end++
		}
		if end-start != pldSubmarkets {
			return &PLDError{"incomplete", rows[start].line}
		}
		start = end
	}

	// Go's % keeps the sign of a pre-epoch hour; Python's does not.
	if floorMod(rows[0].hour, 24) != 0 {
		return &PLDError{"partial_day", rows[0].line}
	}
	if last := rows[len(rows)-1]; floorMod(last.hour, 24) != 23 {
		return &PLDError{"partial_day", last.line}
	}
	return nil
}

func floorMod(a, b int64) int64 { return ((a % b) + b) % b }

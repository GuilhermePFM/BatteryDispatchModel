package quota

import (
	"testing"
	"time"
)

func TestRetryAfter(t *testing.T) {
	at := time.Date(2026, 11, 18, 23, 59, 30, 500e6, time.UTC)
	if got := UntilMidnight(at); got != 30 {
		t.Errorf("UntilMidnight %d", got)
	}
	if got := UntilNextMinute(at); got != 30 {
		t.Errorf("UntilNextMinute %d", got)
	}
	if got := UntilMidnight(time.Date(2026, 11, 18, 0, 0, 0, 0, time.UTC)); got != 86400 {
		t.Errorf("at midnight %d", got)
	}
}

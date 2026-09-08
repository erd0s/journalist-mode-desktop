package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestQuitRequiresEveryWindowAndRejectsStaleApprovals(t *testing.T) {
	var gate quitGate
	token, started := gate.begin([]uint{3, 9}, true, true)
	if !started || gate.permitted() {
		t.Fatal("quit should wait for journals")
	}
	if _, started := gate.begin([]uint{3}, false, false); started {
		t.Fatal("overlapping quit")
	}
	if gate.approve(token, 9) {
		t.Fatal("approved wrong journal")
	}
	if committed, _ := gate.commit(token, func() error { t.Fatal("premature prepare"); return nil }); committed {
		t.Fatal("premature quit")
	}
	if !gate.approve(token, 3) || gate.approve(token, 3) {
		t.Fatal("duplicate approval")
	}
	if !gate.cancel(token) || gate.pending() {
		t.Fatal("cancel did not restore editing")
	}
	if gate.approve(token, 9) {
		t.Fatal("accepted stale approval")
	}
	newToken, _ := gate.begin([]uint{3, 9}, true, true)
	if newToken == token || gate.cancel(token) {
		t.Fatal("stale token cancelled a new quit")
	}
	gate.approve(newToken, 3)
	gate.approve(newToken, 9)
	if committed, err := gate.commit(newToken, func() error { return nil }); !committed || err != nil || !gate.permitted() {
		t.Fatal("all windows approved but quit did not proceed")
	}
}

func TestQuitCannotProceedWhenRememberingDaysFails(t *testing.T) {
	var gate quitGate
	token, _ := gate.begin(nil, true, true)
	failure := errors.New("disk full")
	committed, err := gate.commit(token, func() error { return failure })
	if committed || !errors.Is(err, failure) || gate.permitted() {
		t.Fatal("lost relaunch state allowed quit")
	}
	if !gate.cancel(token) {
		t.Fatal("failed quit must remain cancellable")
	}
}

func TestRelaunchDaysValidateRootAndDatesAndConsumeOnce(t *testing.T) {
	dir := t.TempDir()
	app := newAppForPaths(dir, filepath.Join(dir, "settings.json"))
	settings, err := app.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	write := func(data string) {
		t.Helper()
		if err := os.WriteFile(app.relaunchPath(), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"storageRoot":"/another-root","dates":["2026-09-08"]}`)
	if _, err := app.takeRelaunchDays(); err == nil {
		t.Fatal("restored journals from a different root")
	}
	write(`{"storageRoot":"` + settings.StorageRoot + `","dates":["../escape"]}`)
	if _, err := app.takeRelaunchDays(); err == nil {
		t.Fatal("accepted invalid day")
	}
	write(`{"storageRoot":"` + settings.StorageRoot + `","dates":["2026-09-08","2026-09-08","2026-09-07"]}`)
	dates, err := app.takeRelaunchDays()
	if err != nil || len(dates) != 2 || dates[0] != "2026-09-08" {
		t.Fatalf("restore: %v %v", dates, err)
	}
	dates, err = app.takeRelaunchDays()
	if err != nil || len(dates) != 0 {
		t.Fatal("relaunch state was not consumed")
	}
}

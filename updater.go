package main

// Supplied by the build task so a running process keeps its own version even
// if somebody replaces the bundle on disk before restarting it.
var buildVersion = "Development build"

// UpdateStatus describes the running bundle, not a version from the website.
type UpdateStatus struct {
	Version         string `json:"version"`
	AutomaticChecks bool   `json:"automaticChecks"`
}

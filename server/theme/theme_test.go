package theme

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestHeadContainsResolverAndThemes(t *testing.T) {
	var buf bytes.Buffer
	if err := Head(Config{Light: "memory-light", Dark: "memory"}).Render(context.Background(), &buf); err != nil {
		t.Fatalf("render Head: %v", err)
	}
	out := buf.String()

	for _, want := range []string{
		"emergent-feedback-theme", // shared storage key
		"memory-light",            // light theme name
		"memory",                  // dark theme name
		"prefers-color-scheme",    // OS detection
		"data-theme",              // stamped attribute
		"localStorage",            // persistence
		"matchMedia",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("Head output missing %q\n---\n%s", want, out)
		}
	}
	if !strings.Contains(out, `name="color-scheme"`) {
		t.Errorf("Head output missing color-scheme meta")
	}
}

func TestHeadDefaultConfigFallsBack(t *testing.T) {
	var buf bytes.Buffer
	if err := Head(Config{}).Render(context.Background(), &buf); err != nil {
		t.Fatalf("render Head: %v", err)
	}
	out := buf.String()
	// Empty config must never emit an unthemed page: defaults are light/dark.
	if !strings.Contains(out, `"light"`) || !strings.Contains(out, `"dark"`) {
		t.Errorf("default Head config missing light/dark fallbacks\n---\n%s", out)
	}
}

func TestToggleContainsThreeWayOptions(t *testing.T) {
	var buf bytes.Buffer
	if err := Toggle().Render(context.Background(), &buf); err != nil {
		t.Fatalf("render Toggle: %v", err)
	}
	out := buf.String()
	for _, want := range []string{
		`data-ef-theme-option="light"`,
		`data-ef-theme-option="dark"`,
		`data-ef-theme-option="system"`,
		`id="ef-theme-toggle"`,
		"__efThemeUIInit",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("Toggle output missing %q", want)
		}
	}
}

func TestJSStringLiteralEscaping(t *testing.T) {
	cases := map[string]string{
		`plain`:     `"plain"`,
		`a"b`:       `"a\"b"`,
		`</script>`: `"\u003c/script\u003e"`,
	}
	for in, want := range cases {
		if got := jsLiteral(in); got != want {
			t.Errorf("jsLiteral(%q) = %q, want %q", in, got, want)
		}
	}
}

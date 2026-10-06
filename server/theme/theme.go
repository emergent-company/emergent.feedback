// Package theme provides the shared Light/Dark/System theme detection and
// toggle used by every server-rendered surface (landing + panel).
//
// The contract is deliberately small:
//
//   - Config maps the app's abstract "light"/"dark" modes onto concrete
//     daisyUI theme names per surface (landing: scalo-light/scalo,
//     panel: nord/dracula).
//   - Head emits a FOUC-safe inline script plus a color-scheme meta. The
//     script must be placed BEFORE the stylesheets so it resolves and applies
//     the persisted/system theme before first paint.
//   - Toggle emits a 3-way Light/Dark/System dropdown backed by one delegated
//     document click listener (no inline handlers).
//
// Both surfaces share StorageKey so the choice is consistent across
// landing <-> panel on the same origin.
package theme

import (
	"encoding/json"
	"fmt"
)

// StorageKey is the single localStorage key shared by all surfaces. It stores
// one of "light", "dark" or "system".
const StorageKey = "emergent-feedback-theme"

// Config maps the two concrete themes a surface uses for light/dark, plus the
// storage key. Empty fields fall back to the library defaults (light/dark,
// StorageKey) so a caller can never emit an unthemed page.
type Config struct {
	Light string
	Dark  string
	Key   string
}

func (c Config) light() string {
	if c.Light == "" {
		return "light"
	}
	return c.Light
}

func (c Config) dark() string {
	if c.Dark == "" {
		return "dark"
	}
	return c.Dark
}

func (c Config) key() string {
	if c.Key == "" {
		return StorageKey
	}
	return c.Key
}

// jsLiteral renders v as a JSON-escaped JavaScript string literal (quotes
// included). Safe for arbitrary theme/key values.
func jsLiteral(v string) string {
	b, err := json.Marshal(v)
	if err != nil {
		return `""`
	}
	return string(b)
}

// headScript is the FOUC-safe resolver: read the persisted mode, resolve
// "system" through matchMedia, and stamp data-theme + color-scheme on the
// document element synchronously. It exposes window.__efTheme so the Toggle
// component can reuse the same resolver. A change listener re-applies only
// while the active mode is "system".
func headScript(cfg Config) string {
	return fmt.Sprintf(`<script>
(function () {
  try {
    var KEY = %s;
    var THEMES = { light: %s, dark: %s };
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    function readMode() {
      var m = "system";
      try {
        var s = localStorage.getItem(KEY);
        if (s === "light" || s === "dark" || s === "system") m = s;
      } catch (e) {}
      return m;
    }
    function resolved(mode) {
      if (mode === "system") return mq.matches ? "dark" : "light";
      return mode;
    }
    function apply(mode) {
      var r = resolved(mode);
      var root = document.documentElement;
      root.setAttribute("data-theme", THEMES[r]);
      root.style.colorScheme = r;
      var meta = document.querySelector('meta[name="color-scheme"]');
      if (meta) meta.setAttribute("content", r);
    }
    apply(readMode());
    window.__efTheme = {
      key: KEY,
      themes: THEMES,
      media: mq,
      readMode: readMode,
      resolve: resolved,
      apply: apply
    };
    mq.addEventListener("change", function () {
      if (readMode() === "system") apply("system");
    });
  } catch (e) {}
})();
</script>`, jsLiteral(cfg.key()), jsLiteral(cfg.light()), jsLiteral(cfg.dark()))
}

// toggleScript wires the dropdown: one delegated click listener, persistence,
// and icon/check painting. It is emitted once per page via a templ.OnceHandle.
func toggleScript() string {
	return `<script>
(function () {
  if (window.__efThemeUIInit) return;
  window.__efThemeUIInit = true;
  var T = window.__efTheme;
  if (!T) return;

  function valid(m) {
    return m === "light" || m === "dark" || m === "system";
  }
  function current() {
    var m = "system";
    try {
      var s = localStorage.getItem(T.key);
      if (valid(s)) m = s;
    } catch (e) {}
    return m;
  }
  function paint(mode) {
    ["light", "dark", "system"].forEach(function (m) {
      var icon = document.getElementById("ef-theme-icon-" + m);
      if (icon) icon.style.display = m === mode ? "" : "none";
      var check = document.getElementById("ef-theme-check-" + m);
      if (check) check.style.display = m === mode ? "" : "none";
    });
    var trigger = document.getElementById("ef-theme-toggle");
    if (trigger) trigger.setAttribute("aria-label", "Theme: " + mode.charAt(0).toUpperCase() + mode.slice(1));
  }
  function set(mode) {
    if (!valid(mode)) return;
    try { localStorage.setItem(T.key, mode); } catch (e) {}
    T.apply(mode);
    paint(mode);
  }
  document.addEventListener("click", function (e) {
    var option = e.target.closest("[data-ef-theme-option]");
    if (!option) return;
    set(option.getAttribute("data-ef-theme-option"));
  });
  paint(current());
})();
</script>`
}

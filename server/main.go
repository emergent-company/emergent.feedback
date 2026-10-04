package main

import (
	"fmt"
	"net/http"
	"os"

	"github.com/emergent-company/emergent.feedback/server/app"
)

func main() {
	opts, cleanup, err := app.OptionsFromEnv()
	if err != nil {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
	defer cleanup()

	e, err := app.BuildRouter(opts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fatal: build router: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("emergent.feedback %s (%s) listening on :%s\n", app.Version, app.Commit, opts.Port)
	if err := e.Start(":" + opts.Port); err != nil && err != http.ErrServerClosed {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
}

package store

import "testing"

func TestRebind(t *testing.T) {
	cases := []struct {
		name string
		in   string
		pg   string
	}{
		{
			name: "single placeholder",
			in:   `SELECT * FROM t WHERE a = ?`,
			pg:   `SELECT * FROM t WHERE a = $1`,
		},
		{
			name: "two placeholders",
			in:   `SELECT * FROM t WHERE a = ? AND b = ?`,
			pg:   `SELECT * FROM t WHERE a = $1 AND b = $2`,
		},
		{
			name: "question mark inside literal",
			in:   `WHERE note = 'what?' AND a = ?`,
			pg:   `WHERE note = 'what?' AND a = $1`,
		},
		{
			name: "escaped quote inside literal",
			in:   `WHERE note = 'it''s ?' AND a = ?`,
			pg:   `WHERE note = 'it''s ?' AND a = $1`,
		},
		{
			name: "no placeholder",
			in:   `SELECT 1`,
			pg:   `SELECT 1`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := dialectSQLite.rebind(tc.in); got != tc.in {
				t.Fatalf("sqlite rebind(%q) = %q, want identity %q", tc.in, got, tc.in)
			}
			if got := dialectPostgres.rebind(tc.in); got != tc.pg {
				t.Fatalf("postgres rebind(%q) = %q, want %q", tc.in, got, tc.pg)
			}
		})
	}
}

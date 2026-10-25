// Collect licenses for modules actually linked into this target's helper.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

func main() {
	if err := collect(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func collect() error {
	cmd := exec.Command("go", "list", "-deps", "-f", "{{with .Module}}{{.Path}}|{{.Version}}|{{.Dir}}{{end}}", ".")
	cmd.Env = os.Environ()
	for _, dimension := range []string{"GOOS", "GOARCH"} {
		if value := os.Getenv("HATTERA_LICENSE_" + dimension); value != "" {
			cmd.Env = append(cmd.Env, dimension+"="+value)
		}
	}
	output, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("list network dependencies: %w", err)
	}
	modules := map[string][]string{}
	for _, line := range strings.Split(string(output), "\n") {
		parts := strings.Split(strings.TrimSpace(line), "|")
		if len(parts) == 3 && parts[1] != "" {
			modules[parts[0]] = parts
		}
	}
	root, err := exec.Command("go", "env", "GOROOT").Output()
	if err != nil {
		return err
	}
	modules["Go standard library"] = []string{"Go standard library", "", strings.TrimSpace(string(root))}
	keys := make([]string, 0, len(modules))
	for key := range modules {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	fmt.Println("Hattera private network helper — third-party notices")
	for _, key := range keys {
		parts := modules[key]
		found := false
		for _, name := range []string{"LICENSE", "LICENSE.txt", "LICENSE.md", "COPYING", "COPYING.txt", "LICENCE", "LICENCE.txt"} {
			license, err := os.ReadFile(filepath.Join(parts[2], name))
			if err == nil {
				fmt.Printf("\n===== %s %s =====\n%s\n", key, parts[1], license)
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("missing license for network dependency %s", key)
		}
	}
	return nil
}

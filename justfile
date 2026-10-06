default: help

# Show available commands
help:
    @just --list --unsorted

# Validate every addresses/*.json against the Zod schema + check abi/ generated files are up to date
[group('audit')]
validate:
    cd scripts && deno task validate && deno task generate-abi --check

# Run the scripts' unit tests
[group('audit')]
test:
    cd scripts && deno task test

# Report per-network coverage grouped by status + per-section gap summary
[group('audit')]
coverage *args:
    cd scripts && deno task coverage {{ args }}

# Ingest a chain from its ProtocolFactory (usage: just ingest <chainId> <rpc> <pf> [network])
[group('ingest')]
ingest *args:
    cd scripts && deno task ingest {{ args }}

# Import a PluginArtifact envelope (or a directory of them) into addresses/<chainId>.json
[group('ingest')]
import-plugin *args:
    cd scripts && INVOCATION_DIR={{ invocation_directory() }} deno task import-plugin {{ args }}

# Read all on-chain versions of a plugin's PluginRepo and merge them into addresses/<chainId>.json (usage: just refresh-plugin <slug> <chainId> <rpcUrl>)
[group('ingest')]
refresh-plugin *args:
    cd scripts && INVOCATION_DIR={{ invocation_directory() }} deno task refresh-plugin {{ args }}

# Fetch every ABI version pinned in abi/sources.json into abi/<slug>/<version>/ (usage: just import-abi [slug] [version] [--dry-run])
[group('abi')]
import-abi *args:
    cd scripts && deno task import-abi {{ args }}

# Regenerate abi/**/index.ts and the root copies of the latest version (--check: fail if stale, write nothing)
[group('abi')]
generate-abi *args:
    cd scripts && deno task generate-abi {{ args }}

# Check every plugin version in addresses/ against its versioned ABI on-chain (usage: just verify-abi [network])
[group('abi')]
verify-abi *args:
    cd scripts && deno task verify-abi {{ args }}

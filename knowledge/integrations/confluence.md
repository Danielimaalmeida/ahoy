# Confluence integration conventions

## Routing

| Setting | Value |
| --- | --- |
| Space | `R3DA` |
| Business logic / product reference | [niooo - User Guide](https://atc.asdgroup.net/confluence/spaces/R3DA/pages/8255529813/niooo+-+User+Guide) |
| Product documentation | [niooo - Product Depot](https://atc.asdgroup.net/confluence/spaces/R3DA/pages/7018459796/niooo+-+Product+Depot) |
| Process reference | [Agile Working Model](https://atc.asdgroup.net/confluence/spaces/AWM/pages/236906918/Agile+Working+Model) (space `AWM`) |

## Product Depot

The Product Depot holds the manuals that back the product's YPA. Its
[Operations Manual](https://atc.asdgroup.net/confluence/spaces/R3DA/pages/7020022578/niooo+-+Operations+Manual)
subtree changes most often, as operational processes are documented or revised.

`.github/agents/awm-harbourmaster.agent.md` maintains these pages on request.
It updates existing pages only, and writes nothing without explicit human
authorization.

**Never touched, by any agent:**
[niooo - IT Security Documentation](https://atc.asdgroup.net/confluence/spaces/R3DA/pages/7020022589/niooo+-+IT+Security+Documentation),
the Product Depot root page, and the `ITGOV` master content included into it.

## Usage

Navigator reads this page for product and business-logic context during Jira
story intake, per `.github/agents/navigator.agent.md`, using the configured
Confluence MCP. Treat it as a pointer, not a copy: do not duplicate
its content into this repository. If the page moves or is replaced, update
the link here rather than adding a new file.

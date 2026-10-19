# NutriPal MCP v0.4.1

## Auth prompt reliability

The hidden MyFitnessPal session-token prompt now reads raw terminal input through explicit input events. Enter submits the token, while Ctrl+C and Ctrl+D restore normal terminal mode before exiting. The prompt also rejects an empty token and prints a status before checking the session with MyFitnessPal.

This patch release changes the `auth` command only. It does not alter MyFitnessPal API behavior or stored session formats.

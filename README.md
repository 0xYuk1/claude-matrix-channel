# claude-matrix-channel

A [Claude Code Channel](https://code.claude.com/docs/en/channels-reference) that bridges Matrix to Claude Code. Control Claude Code from your phone via any Matrix client.

> vibe coded with claude

## What it does

- **Two-way messaging** — send messages from Matrix, Claude reads and acts on them, replies back to the room
- **Image support** — send images from Matrix, Claude can view them
- **File support** — send files from Matrix, Claude can access them
- **Permission relay** — when Claude needs to run a tool, it asks in Matrix. Approve or deny from your phone
- **Auto-join** — bot automatically joins rooms when invited
- **Sender gating** — only specified Matrix users can interact with Claude

## Requirements

- Node.js 18+
- Claude Code v2.1.80+
- A Matrix homeserver with a bot account
- Claude Pro subscription (channels require claude.ai login)

## Setup

1. Clone and install:
```bash
git clone https://github.com/0xYuk1/claude-matrix-channel.git
cd claude-matrix-channel
npm install
```

2. Create a bot account on your Matrix homeserver

3. Add to `~/.claude.json`:
```json
{
  "mcpServers": {
    "matrix": {
      "command": "node",
      "args": ["/path/to/claude-matrix-channel/matrix-channel.mjs"],
      "env": {
        "MATRIX_HOMESERVER": "https://your-homeserver.example.com",
        "MATRIX_BOT_TOKEN": "your-bot-access-token",
        "MATRIX_BOT_USER_ID": "@botname:your-homeserver.example.com",
        "MATRIX_ALLOWED_USERS": "@you:your-homeserver.example.com"
      }
    }
  }
}
```

4. Create a room in your Matrix client and invite the bot

5. Start Claude Code with the channel:
```bash
claude --dangerously-load-development-channels server:matrix
```

6. Send a message in the Matrix room — Claude will respond

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `MATRIX_HOMESERVER` | yes | Full URL to your Matrix homeserver |
| `MATRIX_BOT_TOKEN` | yes | Access token for the bot account |
| `MATRIX_BOT_USER_ID` | yes | Full Matrix user ID of the bot (e.g. `@bot:server.com`) |
| `MATRIX_ALLOWED_USERS` | no | Comma-separated list of allowed Matrix user IDs. If empty, all users in joined rooms can interact |

## Permission Relay

When Claude wants to run a tool (edit a file, execute a command), it sends a permission prompt to the Matrix room:

```
🔐 Claude wants to run Bash:
List files in current directory

Reply `yes abcde` or `no abcde`
```

Reply with the verdict from your phone. The local terminal dialog stays open too — whichever answer arrives first is applied.

## Architecture

```
Phone (Matrix client) → Matrix homeserver → Channel MCP server (local) → Claude Code
                                          ← replies back to Matrix room ←
```

The channel server runs locally on the same machine as Claude Code. It communicates with Claude Code over stdio (no network). It connects to your Matrix homeserver to poll for messages and send replies.

## License

MIT

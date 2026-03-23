#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// --- Config ---
const HOMESERVER = process.env.MATRIX_HOMESERVER
const BOT_TOKEN = process.env.MATRIX_BOT_TOKEN
const BOT_USER_ID = process.env.MATRIX_BOT_USER_ID
const ALLOWED_USERS = new Set((process.env.MATRIX_ALLOWED_USERS || '').split(',').filter(Boolean))

if (!BOT_TOKEN || !HOMESERVER || !BOT_USER_ID) {
  process.stderr.write('Required env vars: MATRIX_HOMESERVER, MATRIX_BOT_TOKEN, MATRIX_BOT_USER_ID\n')
  process.exit(1)
}

// --- Matrix API helpers ---
async function matrixFetch(path, opts = {}) {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  })
  return res.json()
}

async function sendMessage(roomId, text) {
  const txnId = Date.now() + Math.random().toString(36).slice(2)
  // Convert basic markdown bold to HTML
  const html = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>')
  const content = {
    msgtype: 'm.text',
    body: text,
    format: 'org.matrix.custom.html',
    formatted_body: html.replace(/\n/g, '<br>'),
  }
  return matrixFetch(`/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, {
    method: 'PUT',
    body: JSON.stringify(content),
  })
}

async function joinRoom(roomId) {
  return matrixFetch(`/join/${encodeURIComponent(roomId)}`, { method: 'POST', body: '{}' })
}

const MEDIA_DIR = join(tmpdir(), 'claude-matrix-media')
await mkdir(MEDIA_DIR, { recursive: true })

async function downloadMedia(mxcUrl) {
  // mxc://server/mediaId → /_matrix/media/v3/download/server/mediaId
  const match = mxcUrl.match(/^mxc:\/\/([^/]+)\/(.+)$/)
  if (!match) return null
  const [, server, mediaId] = match
  const res = await fetch(`${HOMESERVER}/_matrix/client/v1/media/download/${server}/${mediaId}`, {
    headers: { 'Authorization': `Bearer ${BOT_TOKEN}` },
  })
  if (!res.ok) return null
  const contentType = res.headers.get('content-type') || 'image/png'
  const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? '.jpg'
    : contentType.includes('png') ? '.png'
    : contentType.includes('gif') ? '.gif'
    : contentType.includes('webp') ? '.webp'
    : '.bin'
  const filename = `${mediaId}${ext}`
  const filepath = join(MEDIA_DIR, filename)
  const buffer = Buffer.from(await res.arrayBuffer())
  await writeFile(filepath, buffer)
  return filepath
}

// --- MCP Channel Server ---
const mcp = new Server(
  { name: 'matrix', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions:
      'Messages arrive as <channel source="matrix" room_id="..." sender="...">. ' +
      'Reply with the reply tool, passing the room_id from the tag. ' +
      'When an image is sent, it is downloaded and the path is in image_path attribute. Use the Read tool to view it. ' +
      'Permission prompts will also be forwarded to Matrix — the user can approve or deny from their phone.',
  },
)

// Reply tool
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Send a message back to a Matrix room',
    inputSchema: {
      type: 'object',
      properties: {
        room_id: { type: 'string', description: 'The Matrix room to reply in' },
        text: { type: 'string', description: 'The message to send' },
      },
      required: ['room_id', 'text'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'reply') {
    const { room_id, text, body } = req.params.arguments
    await sendMessage(room_id, text || body || '')
    return { content: [{ type: 'text', text: 'sent' }] }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})

// Permission relay
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

let permissionRoomId = null

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  if (!permissionRoomId) return
  await sendMessage(
    permissionRoomId,
    `🔐 Claude wants to run **${params.tool_name}**:\n${params.description}\n\nReply \`yes ${params.request_id}\` or \`no ${params.request_id}\``,
  )
})

await mcp.connect(new StdioServerTransport())

// --- Matrix sync loop ---
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
let syncToken = null

// Auto-join rooms on invite
async function handleInvites(rooms) {
  for (const roomId of Object.keys(rooms)) {
    process.stderr.write(`Invited to ${roomId}, joining...\n`)
    await joinRoom(roomId)
  }
}

async function handleMessages(rooms) {
  for (const [roomId, room] of Object.entries(rooms)) {
    const events = room.timeline?.events || []
    for (const event of events) {
      if (event.type !== 'm.room.message') continue
      if (event.sender === BOT_USER_ID) continue

      // Sender gating
      if (ALLOWED_USERS.size > 0 && !ALLOWED_USERS.has(event.sender)) {
        process.stderr.write(`Blocked message from ${event.sender}\n`)
        continue
      }

      const body = event.content?.body || ''
      const msgtype = event.content?.msgtype || ''
      permissionRoomId = roomId

      // Check for permission verdict
      const m = PERMISSION_REPLY_RE.exec(body)
      if (m) {
        await mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: {
            request_id: m[2].toLowerCase(),
            behavior: m[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
          },
        })
        continue
      }

      // Handle image messages
      if (msgtype === 'm.image' && event.content?.url) {
        const filepath = await downloadMedia(event.content.url)
        if (filepath) {
          await mcp.notification({
            method: 'notifications/claude/channel',
            params: {
              content: body
                ? `[Image: ${body}] saved to ${filepath}`
                : `[Image] saved to ${filepath}`,
              meta: {
                room_id: roomId,
                sender: event.sender,
                image_path: filepath,
              },
            },
          })
          continue
        }
      }

      // Handle file messages
      if (msgtype === 'm.file' && event.content?.url) {
        const filepath = await downloadMedia(event.content.url)
        if (filepath) {
          await mcp.notification({
            method: 'notifications/claude/channel',
            params: {
              content: `[File: ${body}] saved to ${filepath}`,
              meta: {
                room_id: roomId,
                sender: event.sender,
                file_path: filepath,
              },
            },
          })
          continue
        }
      }

      // Forward as text message
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: body,
          meta: {
            room_id: roomId,
            sender: event.sender,
          },
        },
      })
    }
  }
}

async function sync() {
  while (true) {
    try {
      const params = new URLSearchParams({
        timeout: '30000',
        filter: JSON.stringify({
          room: {
            timeline: { limit: 10 },
            state: { lazy_load_members: true },
          },
        }),
      })
      if (syncToken) params.set('since', syncToken)

      const data = await matrixFetch(`/sync?${params}`)

      if (data.rooms?.invite) await handleInvites(data.rooms.invite)
      if (data.rooms?.join && syncToken) await handleMessages(data.rooms.join)

      syncToken = data.next_batch
    } catch (err) {
      process.stderr.write(`Sync error: ${err.message}\n`)
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}

process.stderr.write('Matrix channel started, syncing...\n')
sync()

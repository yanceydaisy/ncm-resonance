import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NeteaseClient } from "./client.js";

const songSchema = z.object({
  id: z.string(),
  name: z.string(),
  artist: z.string(),
  durationMs: z.number(),
  coverUrl: z.string().optional(),
});

const playlistSchema = z.object({
  id: z.string(),
  name: z.string(),
  trackCount: z.number(),
  creatorId: z.string().nullable(),
  owned: z.boolean(),
  privacy: z.number().nullable(),
});

export function registerNeteaseAccountTools(server: McpServer, client: NeteaseClient): void {
  server.registerTool(
    "netease_search_songs",
    {
      title: "Search NetEase Music",
      description: "Search NetEase Cloud Music songs using the connected NetEase account session.",
      inputSchema: {
        query: z.string().trim().min(1).max(120),
        limit: z.number().int().min(1).max(20).default(10),
      },
      outputSchema: { songs: z.array(songSchema) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ query, limit }) => {
      const songs = await client.searchSongs(query, limit);
      return {
        structuredContent: { songs },
        content: [{ type: "text", text: JSON.stringify({ songs }) }],
      };
    },
  );

  server.registerTool(
    "netease_my_playlists",
    {
      title: "NetEase playlists",
      description: "List playlists visible on the connected NetEase account, including whether each playlist is owned by the connected account.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(50),
      },
      outputSchema: { playlists: z.array(playlistSchema) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ limit }) => {
      const playlists = await client.listOwnPlaylists(limit);
      return {
        structuredContent: { playlists },
        content: [{ type: "text", text: JSON.stringify({ playlists }) }],
      };
    },
  );

  server.registerTool(
    "netease_playlist_tracks",
    {
      title: "NetEase playlist tracks",
      description: "Read songs from a NetEase playlist using the connected account session.",
      inputSchema: {
        playlistId: z.string().trim().min(1).max(40),
        limit: z.number().int().min(1).max(100).default(50),
      },
      outputSchema: { songs: z.array(songSchema) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ playlistId, limit }) => {
      const songs = await client.getPlaylistTracks(playlistId, limit);
      return {
        structuredContent: { songs },
        content: [{ type: "text", text: JSON.stringify({ songs }) }],
      };
    },
  );

  server.registerTool(
    "netease_create_playlist",
    {
      title: "Create a NetEase playlist",
      description: "Create a real playlist on the connected NetEase account.",
      inputSchema: {
        name: z.string().trim().min(1).max(80),
        privacy: z.enum(["public", "private"]).default("public"),
      },
      outputSchema: {
        playlist: z.object({
          id: z.string(),
          name: z.string(),
          privacy: z.number(),
        }),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async ({ name, privacy }) => {
      const playlist = await client.createPlaylist(name, privacy === "private" ? 10 : 0);
      return {
        structuredContent: { playlist },
        content: [{ type: "text", text: JSON.stringify({ playlist }) }],
      };
    },
  );

  server.registerTool(
    "netease_add_to_playlist",
    {
      title: "Add songs to a NetEase playlist",
      description: "Add one or more songs to a real playlist on the connected NetEase account.",
      inputSchema: {
        playlistId: z.string().trim().min(1).max(40),
        songIds: z.array(z.string().trim().min(1).max(40)).min(1).max(50),
      },
      outputSchema: {
        ok: z.boolean(),
        playlistId: z.string(),
        songIds: z.array(z.string()),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ playlistId, songIds }) => {
      await client.updatePlaylistTracks(playlistId, songIds, "add");
      const result = { ok: true, playlistId, songIds };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "netease_remove_from_playlist",
    {
      title: "Remove songs from a NetEase playlist",
      description: "Remove one or more songs from a real playlist on the connected NetEase account.",
      inputSchema: {
        playlistId: z.string().trim().min(1).max(40),
        songIds: z.array(z.string().trim().min(1).max(40)).min(1).max(50),
      },
      outputSchema: {
        ok: z.boolean(),
        playlistId: z.string(),
        songIds: z.array(z.string()),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ playlistId, songIds }) => {
      await client.updatePlaylistTracks(playlistId, songIds, "del");
      const result = { ok: true, playlistId, songIds };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "netease_like_song",
    {
      title: "Set NetEase like state",
      description: "Like or unlike a song on the connected NetEase account.",
      inputSchema: {
        songId: z.string().trim().min(1).max(40),
        like: z.boolean().default(true),
      },
      outputSchema: {
        ok: z.boolean(),
        songId: z.string(),
        liked: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ songId, like }) => {
      await client.likeSong(songId, like);
      const result = { ok: true, songId, liked: like };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "netease_play_history",
    {
      title: "NetEase play history",
      description: "Read listening history and play counts for the connected NetEase account.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(30),
        allTime: z.boolean().default(false),
      },
      outputSchema: {
        records: z.array(z.object({
          song: songSchema,
          playCount: z.number(),
          score: z.number().nullable(),
        })),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ limit, allTime }) => {
      const records = await client.getPlayHistory(limit, allTime);
      return {
        structuredContent: { records },
        content: [{ type: "text", text: JSON.stringify({ records }) }],
      };
    },
  );

  server.registerTool(
    "netease_daily_recommend",
    {
      title: "NetEase daily recommendations",
      description: "Read today's personalized song recommendations for the connected NetEase account.",
      inputSchema: {
        limit: z.number().int().min(1).max(30).default(30),
      },
      outputSchema: {
        songs: z.array(songSchema.extend({ reason: z.string().nullable() })),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ limit }) => {
      const songs = await client.getDailyRecommendations(limit);
      return {
        structuredContent: { songs },
        content: [{ type: "text", text: JSON.stringify({ songs }) }],
      };
    },
  );
}


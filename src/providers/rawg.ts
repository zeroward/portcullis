import { z } from "zod";
import { ProviderHttp, pathId } from "./http.js";

const image = z.url().nullable().optional();
const gameSummary = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  released: z.string().nullable().optional(),
  background_image: image,
  platforms: z
    .array(z.object({ platform: z.object({ name: z.string() }) }))
    .nullable()
    .optional(),
});
const searchResponse = z.object({ results: z.array(gameSummary) });
const gameDetail = z.object({
  id: z.number().int().positive(),
  slug: z.string(),
  name: z.string(),
  description_raw: z.string().default(""),
  background_image: image,
  website: z.string().nullable().optional(),
  genres: z.array(z.object({ name: z.string() })).default([]),
  tags: z.array(z.object({ name: z.string() })).default([]),
});
const screenshotsResponse = z.object({
  results: z.array(z.object({ image: z.url() })),
});

export interface GameMetadataResult {
  id: string;
  name: string;
  released?: string;
  image?: string;
  platforms: string[];
}

export interface GameMetadata {
  name: string;
  summary: string;
  description: string;
  category: string;
  tags: string[];
  cover?: string;
  screenshots: string[];
  source: { provider: "rawg"; url: string };
  website?: string;
}

export interface GameMetadataProvider {
  search(query: string): Promise<GameMetadataResult[]>;
  game(id: string): Promise<GameMetadata>;
}

const concise = (value: string, max: number) => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
};

export class RawgClient implements GameMetadataProvider {
  readonly http: ProviderHttp;

  constructor(
    readonly apiKey: string,
    base = "https://api.rawg.io",
  ) {
    this.http = new ProviderHttp("rawg", base, { "x-api-key": apiKey });
  }

  async search(query: string): Promise<GameMetadataResult[]> {
    const q = new URLSearchParams({
      key: this.apiKey,
      search: query,
      search_precise: "true",
      page_size: "10",
    });
    const response = await this.http.request(
      "GET",
      `/api/games?${q}`,
      searchResponse,
    );
    return response.results.map((game) => ({
      id: String(game.id),
      name: game.name,
      ...(game.released ? { released: game.released } : {}),
      ...(game.background_image ? { image: game.background_image } : {}),
      platforms: (game.platforms ?? []).map((p) => p.platform.name).slice(0, 8),
    }));
  }

  async game(id: string): Promise<GameMetadata> {
    const key = encodeURIComponent(this.apiKey);
    const safeId = pathId(id);
    const [game, screenshots] = await Promise.all([
      this.http.request("GET", `/api/games/${safeId}?key=${key}`, gameDetail),
      this.http.request(
        "GET",
        `/api/games/${safeId}/screenshots?key=${key}&page_size=6`,
        screenshotsResponse,
      ),
    ]);
    const description = game.description_raw.trim().slice(0, 40_000);
    return {
      name: concise(game.name, 100),
      summary: concise(description, 240),
      description,
      category: (game.genres[0]?.name ?? "Game").slice(0, 80),
      tags: [...game.genres, ...game.tags]
        .map((tag) => tag.name)
        .filter((tag) => tag.length <= 40)
        .filter((tag, index, all) => all.indexOf(tag) === index)
        .slice(0, 12),
      ...(game.background_image ? { cover: game.background_image } : {}),
      screenshots: screenshots.results.map((s) => s.image).slice(0, 6),
      source: {
        provider: "rawg",
        url: `https://rawg.io/games/${encodeURIComponent(game.slug)}`,
      },
      ...(game.website && z.url().safeParse(game.website).success
        ? { website: game.website }
        : {}),
    };
  }
}

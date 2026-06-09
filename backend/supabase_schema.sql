-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- Channels Table
CREATE TABLE IF NOT EXISTS youtube_channels (
    id VARCHAR PRIMARY KEY,
    title VARCHAR NOT NULL,
    description TEXT,
    thumbnail_url VARCHAR,
    uploads_playlist_id VARCHAR,
    subscriber_count BIGINT DEFAULT 0,
    last_synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Videos Table
CREATE TABLE IF NOT EXISTS youtube_videos (
    id VARCHAR PRIMARY KEY,
    channel_id VARCHAR REFERENCES youtube_channels(id) ON DELETE CASCADE,
    title VARCHAR NOT NULL,
    clean_description TEXT,
    published_at TIMESTAMP WITH TIME ZONE,
    view_count BIGINT DEFAULT 0,
    thumbnail_url VARCHAR,
    embedding vector(768), -- Gemini 004 / 2.5 flash embeddings output 768 dims
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- User Subscriptions (Mapping table)
CREATE TABLE IF NOT EXISTS user_subscriptions (
    user_id VARCHAR NOT NULL,
    channel_id VARCHAR REFERENCES youtube_channels(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (user_id, channel_id)
);

-- Fast Semantic Search Index (HNSW)
CREATE INDEX IF NOT EXISTS youtube_videos_embedding_idx ON youtube_videos USING hnsw (embedding vector_cosine_ops);

-- Hybrid Search Function (RPC)
CREATE OR REPLACE FUNCTION search_youtube_videos (
  query_embedding vector(768),
  match_count int DEFAULT 5,
  similarity_threshold float DEFAULT 0.3,
  target_user_id VARCHAR DEFAULT NULL
)
RETURNS TABLE (
  id VARCHAR,
  channel_id VARCHAR,
  channel_title VARCHAR,
  title VARCHAR,
  clean_description TEXT,
  thumbnail_url VARCHAR,
  published_at TIMESTAMP WITH TIME ZONE,
  view_count BIGINT,
  similarity float,
  from_subscription BOOLEAN
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    v.id,
    v.channel_id,
    c.title AS channel_title,
    v.title,
    v.clean_description,
    v.thumbnail_url,
    v.published_at,
    v.view_count,
    1 - (v.embedding <=> query_embedding) AS similarity,
    (us.user_id IS NOT NULL) AS from_subscription
  FROM youtube_videos v
  JOIN youtube_channels c ON c.id = v.channel_id
  LEFT JOIN user_subscriptions us
    ON us.channel_id = v.channel_id
   AND us.user_id = target_user_id
  WHERE 1 - (v.embedding <=> query_embedding) > similarity_threshold
    AND (target_user_id IS NULL OR us.user_id IS NOT NULL)
  ORDER BY 
    (1 - (v.embedding <=> query_embedding)) DESC 
  LIMIT match_count;
END;
$$;

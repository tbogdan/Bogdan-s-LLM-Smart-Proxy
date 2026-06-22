"use strict";

/**
 * transform-coverage — minimal helpers documenting transform boundaries
 *
 * Covers the two OpenAI Chat pivot paths:
 *   1. Responses API (Codex) → OpenAI Chat pivot
 *   2. Windsurf Connect → OpenAI Chat pivot (via Anthropic gateway)
 *
 * Neither path requires new wire logic: both already route through
 * mediaContent.toOpenAIChatContent.  This file makes the boundary
 * contract explicit and testable without touching the hot paths.
 */

const mediaContent = require("./media-content");

// ---------------------------------------------------------------------------
// Responses API content shape → OpenAI Chat part
// ---------------------------------------------------------------------------

/**
 * responsesContentToOpenAIChat
 *
 * Converts a single Responses API input content item (input_text, input_image)
 * or a standard OpenAI Chat part (text, image_url) to the canonical OpenAI
 * Chat part shape { type: "text"|"image_url", ... }.
 *
 * Used to document and verify what mediaContent.toOpenAIChatContent does for
 * each Responses-specific type so that test assertions can be written against
 * the exact output shape.
 *
 * @param {object} part  A single content part object
 * @returns {{ type: string } | null}  OpenAI Chat part or null if unrecognised
 */
function responsesContentPartToOpenAIChat(part) {
  if (!part || typeof part !== "object") return null;
  return mediaContent.openAIChatPartFromAny(part);
}

/**
 * responsesContentArrayToOpenAIChat
 *
 * Converts an array of Responses API or standard OpenAI Chat content parts
 * to the canonical OpenAI Chat content shape (string or array).
 *
 * This is the same transformation that transformRequest and translateRequest
 * apply via contentForProvider / mediaContent.toOpenAIChatContent.
 *
 * @param {Array} contentArray  Array of content parts
 * @returns {string | Array}    OpenAI Chat content value
 */
function responsesContentArrayToOpenAIChat(contentArray) {
  if (!Array.isArray(contentArray)) return contentArray;
  return mediaContent.toOpenAIChatContent(contentArray);
}

// ---------------------------------------------------------------------------
// Windsurf/Anthropic content shape → OpenAI Chat part
// ---------------------------------------------------------------------------

/**
 * anthropicImageBlockToOpenAIChat
 *
 * Converts an Anthropic image block (type: "image", source: {...}) to an
 * OpenAI Chat image_url part.  This documents the boundary used by
 * anthropic-gateway.translateRequest when routing Anthropic Messages through
 * the OpenAI Chat pivot toward Windsurf providers.
 *
 * @param {object} part  Anthropic image block
 * @returns {{ type: "image_url", image_url: { url: string } } | null}
 */
function anthropicImageBlockToOpenAIChat(part) {
  if (!part || typeof part !== "object") return null;
  return mediaContent.openAIChatPartFromAny(part);
}

module.exports = {
  responsesContentPartToOpenAIChat,
  responsesContentArrayToOpenAIChat,
  anthropicImageBlockToOpenAIChat,
};

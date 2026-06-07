"use strict";

const TEXT_PART_TYPES = new Set(["text", "input_text", "output_text"]);
const IMAGE_PART_TYPES = new Set(["image", "input_image", "image_url"]);

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function textFromPart(part) {
  if (!part || !TEXT_PART_TYPES.has(part.type)) return "";
  return part.text == null ? "" : String(part.text);
}

function dataUrl(mediaType, data) {
  if (!data) return "";
  return `data:${mediaType || "image/png"};base64,${data}`;
}

function imageSourceUrl(source = {}) {
  if (!isObject(source)) return "";
  if (source.type === "base64" && source.data) {
    return dataUrl(source.media_type || source.mediaType, source.data);
  }
  if (source.type === "url" && source.url) return String(source.url);
  if (source.url) return String(source.url);
  if (source.data) return dataUrl(source.media_type || source.mediaType, source.data);
  return "";
}

function normalizedImageUrl(value, detail) {
  if (typeof value === "string") {
    return value ? { url: value, ...(detail ? { detail } : {}) } : null;
  }
  if (!isObject(value)) return null;
  const url = value.url || value.image_url || value.imageUrl || value.data_url || value.dataUrl;
  if (!url) return null;
  return {
    ...value,
    url: String(url),
    ...(value.detail || !detail ? {} : { detail }),
  };
}

function imageUrlObjectFromPart(part = {}) {
  if (!part || !IMAGE_PART_TYPES.has(part.type)) return null;
  if (part.type === "image_url") {
    return normalizedImageUrl(part.image_url || part.url, part.detail);
  }
  if (part.type === "input_image") {
    return normalizedImageUrl(part.image_url || part.url || part.imageUrl, part.detail) ||
      normalizedImageUrl(imageSourceUrl(part.source || part), part.detail);
  }
  return normalizedImageUrl(part.image_url || part.url || part.imageUrl, part.detail) ||
    normalizedImageUrl(imageSourceUrl(part.source || part), part.detail);
}

function unsupportedImageText(part = {}) {
  if (!part || !IMAGE_PART_TYPES.has(part.type)) return "";
  if (part.file_id || part.fileId) return `[image omitted: unsupported file_id ${part.file_id || part.fileId}]`;
  return "[image omitted: unsupported image reference]";
}

function imagePlaceholderText(part = {}) {
  if (!part || !IMAGE_PART_TYPES.has(part.type)) return "";
  const image = imageUrlObjectFromPart(part);
  if (image?.url) {
    const kind = /^data:/i.test(String(image.url)) ? "data URL" : "URL";
    const detail = image.detail ? ` detail=${image.detail}` : "";
    return `[image omitted: ${kind}${detail}]`;
  }
  return unsupportedImageText(part) || "[image omitted]";
}

function openAIChatPartFromAny(part = {}) {
  const text = textFromPart(part);
  if (text) return { type: "text", text };
  const image = imageUrlObjectFromPart(part);
  if (image) return { type: "image_url", image_url: image };
  const unsupported = unsupportedImageText(part);
  if (unsupported) return { type: "text", text: unsupported };
  return null;
}

function toOpenAIChatContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);

  const parts = [];
  let hasImage = false;
  for (const part of content) {
    const converted = openAIChatPartFromAny(part);
    if (!converted) continue;
    if (converted.type === "image_url") hasImage = true;
    parts.push(converted);
  }
  if (hasImage) return parts;
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text || "")
    .join("\n");
}

function textFromContent(content, options = {}) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  const parts = [];
  for (const part of content) {
    const text = textFromPart(part);
    if (text) {
      parts.push(text);
      continue;
    }
    if (options.imagePlaceholder && part && IMAGE_PART_TYPES.has(part.type)) {
      parts.push(imagePlaceholderText(part) || "[image omitted]");
    }
  }
  return parts.join("\n");
}

function parseDataUrl(url = "") {
  const match = String(url).match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/i);
  if (!match) return null;
  return {
    media_type: match[1] || "image/png",
    data: match[2] || "",
  };
}

function anthropicImageBlockFromAny(part = {}) {
  const image = imageUrlObjectFromPart(part);
  if (!image?.url) return null;
  const parsed = parseDataUrl(image.url);
  if (parsed) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: parsed.media_type,
        data: parsed.data,
      },
    };
  }
  return {
    type: "image",
    source: {
      type: "url",
      url: image.url,
    },
  };
}

function toAnthropicContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);

  const blocks = [];
  let hasImage = false;
  for (const part of content) {
    const text = textFromPart(part);
    if (String(text || "").trim()) {
      blocks.push({ type: "text", text });
      continue;
    }
    const image = anthropicImageBlockFromAny(part);
    if (image) {
      hasImage = true;
      blocks.push(image);
      continue;
    }
    const unsupported = unsupportedImageText(part);
    if (unsupported) blocks.push({ type: "text", text: unsupported });
  }
  if (hasImage) return blocks;
  return blocks.filter((part) => part.type === "text").map((part) => part.text || "").join("\n");
}

function contentHasImage(content) {
  if (!Array.isArray(content)) return false;
  return content.some((part) => part && IMAGE_PART_TYPES.has(part.type));
}

function contentHasDataImage(content) {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const image = imageUrlObjectFromPart(part);
    return /^data:/i.test(String(image?.url || ""));
  });
}

function estimateImagePartTokens(part = {}) {
  const image = imageUrlObjectFromPart(part);
  if (!image?.url && (part.file_id || part.fileId)) return 1024;
  if (!image?.url) return 0;
  const detail = String(image.detail || part.detail || "").toLowerCase();
  const baseTokens = detail === "low" ? 256 : detail === "high" ? 2048 : 1024;
  const dataMatch = String(image.url || "").match(/^data:[^,]*;base64,(.*)$/i);
  if (!dataMatch) return baseTokens;
  return Math.max(baseTokens, Math.ceil((dataMatch[1] || "").length / 4));
}

function estimateImageTokens(content) {
  if (Array.isArray(content)) {
    return content.reduce((total, part) => total + estimateImagePartTokens(part), 0);
  }
  if (isObject(content) && IMAGE_PART_TYPES.has(content.type)) {
    return estimateImagePartTokens(content);
  }
  return 0;
}

function messagesHaveImages(messages = []) {
  return (messages || []).some((message) => contentHasImage(message?.content));
}

function messagesHaveDataImages(messages = []) {
  return (messages || []).some((message) => contentHasDataImage(message?.content));
}

function providerSupportsImageInput(provider = {}) {
  const protocol = String(provider.protocol || "").trim().toLowerCase();
  const caps = new Set(provider.caps || []);
  if (!caps.has("images")) return false;
  if (protocol === "windsurf") return false;
  return true;
}

module.exports = {
  IMAGE_PART_TYPES,
  TEXT_PART_TYPES,
  anthropicImageBlockFromAny,
  contentHasDataImage,
  contentHasImage,
  estimateImagePartTokens,
  estimateImageTokens,
  imagePlaceholderText,
  imageUrlObjectFromPart,
  messagesHaveImages,
  messagesHaveDataImages,
  openAIChatPartFromAny,
  providerSupportsImageInput,
  textFromContent,
  toAnthropicContent,
  toOpenAIChatContent,
};

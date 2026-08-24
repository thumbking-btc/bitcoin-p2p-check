import { binarize, Byte, Charset, Decoder, Detector, Encoder, grayscale } from "@nuintun/qrcode";
import {
  THUMBKING_QR_LOGO_HEIGHT,
  THUMBKING_QR_LOGO_RGBA_BASE64,
  THUMBKING_QR_LOGO_WIDTH,
} from "./thumbking-qr-logo.mjs";

const MAXIMUM_QR_PIXEL_SIZE = 2_048;
const MAXIMUM_QR_SCAN_DIMENSION = 4_096;
const QR_LEVELS = new Set(["L", "M", "Q", "H"]);
const BRAND_LOGO_RATIOS = [0.18, 0.16, 0.14, 0.12, 0.10, 0.08];
let cachedLogoPixels = null;

export class VerifiedQrError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "VerifiedQrError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new VerifiedQrError(code, message);
}

function validateGenerationOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    fail("QR_OPTIONS", "QR 생성 설정을 확인하지 못했습니다.");
  }
  const maximumLength = options.maximumLength ?? 1_200;
  const maximumPixelSize = options.maximumPixelSize ?? 640;
  const quietZoneModules = options.quietZoneModules ?? 4;
  const level = options.level ?? "M";
  const decodeSymbols = options.decodeSymbols ?? decodeQrSymbols;
  if (!Number.isSafeInteger(maximumLength) || maximumLength < 1) {
    fail("QR_OPTIONS", "QR 원문 길이 제한을 확인하지 못했습니다.");
  }
  if (!Number.isSafeInteger(maximumPixelSize) || maximumPixelSize < 1 || maximumPixelSize > MAXIMUM_QR_PIXEL_SIZE) {
    fail("QR_OPTIONS", "QR 픽셀 크기 제한을 확인하지 못했습니다.");
  }
  if (!Number.isSafeInteger(quietZoneModules) || quietZoneModules < 4) {
    fail("QR_OPTIONS", "QR 여백 설정을 확인하지 못했습니다.");
  }
  if (!QR_LEVELS.has(level) || typeof decodeSymbols !== "function") {
    fail("QR_OPTIONS", "QR 인코딩 또는 검증 설정을 확인하지 못했습니다.");
  }
  return { decodeSymbols, level, maximumLength, maximumPixelSize, quietZoneModules };
}

function validateQrImage(image) {
  if (
    !image
    || typeof image !== "object"
    || !Number.isSafeInteger(image.width)
    || !Number.isSafeInteger(image.height)
    || image.width < 1
    || image.height < 1
    || image.width > MAXIMUM_QR_SCAN_DIMENSION
    || image.height > MAXIMUM_QR_SCAN_DIMENSION
    || !(image.data instanceof Uint8ClampedArray)
    || image.data.length !== image.width * image.height * 4
  ) {
    fail("QR_IMAGE", "QR 이미지 형식을 확인하지 못했습니다.");
  }
}

function createByteSegment(payload) {
  for (const character of payload) {
    if (character.codePointAt(0) > 0xff) return new Byte(payload, Charset.UTF_8);
  }
  return new Byte(payload);
}

function renderRaster(encoded, maximumPixelSize, quietZoneModules) {
  const moduleCount = encoded.size;
  const totalModules = moduleCount + quietZoneModules * 2;
  const moduleSize = Math.floor(maximumPixelSize / totalModules);
  if (moduleSize < 2) fail("QR_CAPACITY", "요청이 너무 길어 읽을 수 있는 QR로 만들지 못했습니다.");
  const pixelSize = totalModules * moduleSize;
  let data;
  try {
    data = new Uint8ClampedArray(pixelSize * pixelSize * 4);
  } catch {
    throw new VerifiedQrError("QR_CAPACITY", "요청 QR 이미지 메모리를 확보하지 못했습니다.");
  }
  data.fill(255);
  for (let moduleY = 0; moduleY < moduleCount; moduleY += 1) {
    for (let moduleX = 0; moduleX < moduleCount; moduleX += 1) {
      if (encoded.get(moduleX, moduleY) !== 1) continue;
      const startX = (moduleX + quietZoneModules) * moduleSize;
      const startY = (moduleY + quietZoneModules) * moduleSize;
      for (let y = startY; y < startY + moduleSize; y += 1) {
        for (let x = startX; x < startX + moduleSize; x += 1) {
          const offset = (y * pixelSize + x) * 4;
          data[offset] = 0;
          data[offset + 1] = 0;
          data[offset + 2] = 0;
          data[offset + 3] = 255;
        }
      }
    }
  }
  return { data, height: pixelSize, width: pixelSize };
}

function getLogoPixels() {
  if (cachedLogoPixels) return cachedLogoPixels;
  if (typeof globalThis.atob !== "function") {
    fail("QR_BRAND", "QR 로고 데이터를 읽지 못했습니다.");
  }
  const binary = globalThis.atob(THUMBKING_QR_LOGO_RGBA_BASE64);
  const expectedLength = THUMBKING_QR_LOGO_WIDTH * THUMBKING_QR_LOGO_HEIGHT * 4;
  if (binary.length !== expectedLength) {
    fail("QR_BRAND", "QR 로고 데이터 크기를 확인하지 못했습니다.");
  }
  const pixels = new Uint8ClampedArray(expectedLength);
  for (let index = 0; index < binary.length; index += 1) {
    pixels[index] = binary.charCodeAt(index);
  }
  cachedLogoPixels = pixels;
  return pixels;
}

function fillWhiteCircle(data, width, height, centerX, centerY, radius) {
  const minX = Math.max(0, Math.floor(centerX - radius));
  const maxX = Math.min(width - 1, Math.ceil(centerX + radius));
  const minY = Math.max(0, Math.floor(centerY - radius));
  const maxY = Math.min(height - 1, Math.ceil(centerY + radius));
  const radiusSquared = radius * radius;
  for (let y = minY; y <= maxY; y += 1) {
    const dy = y + 0.5 - centerY;
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x + 0.5 - centerX;
      if (dx * dx + dy * dy > radiusSquared) continue;
      const offset = (y * width + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      data[offset + 3] = 255;
    }
  }
}

function overlayLogo(baseRaster, ratio) {
  const data = new Uint8ClampedArray(baseRaster.data);
  const logoPixels = getLogoPixels();
  const targetSize = Math.max(24, Math.round(Math.min(baseRaster.width, baseRaster.height) * ratio));
  const centerX = baseRaster.width / 2;
  const centerY = baseRaster.height / 2;
  const startX = Math.round(centerX - targetSize / 2);
  const startY = Math.round(centerY - targetSize / 2);

  fillWhiteCircle(data, baseRaster.width, baseRaster.height, centerX, centerY, targetSize * 0.57);

  for (let y = 0; y < targetSize; y += 1) {
    const sourceY = Math.min(
      THUMBKING_QR_LOGO_HEIGHT - 1,
      Math.floor((y * THUMBKING_QR_LOGO_HEIGHT) / targetSize),
    );
    const destinationY = startY + y;
    if (destinationY < 0 || destinationY >= baseRaster.height) continue;
    for (let x = 0; x < targetSize; x += 1) {
      const sourceX = Math.min(
        THUMBKING_QR_LOGO_WIDTH - 1,
        Math.floor((x * THUMBKING_QR_LOGO_WIDTH) / targetSize),
      );
      const destinationX = startX + x;
      if (destinationX < 0 || destinationX >= baseRaster.width) continue;
      const sourceOffset = (sourceY * THUMBKING_QR_LOGO_WIDTH + sourceX) * 4;
      const alpha = logoPixels[sourceOffset + 3] / 255;
      if (alpha <= 0) continue;
      const destinationOffset = (destinationY * baseRaster.width + destinationX) * 4;
      const inverseAlpha = 1 - alpha;
      data[destinationOffset] = Math.round(logoPixels[sourceOffset] * alpha + data[destinationOffset] * inverseAlpha);
      data[destinationOffset + 1] = Math.round(logoPixels[sourceOffset + 1] * alpha + data[destinationOffset + 1] * inverseAlpha);
      data[destinationOffset + 2] = Math.round(logoPixels[sourceOffset + 2] * alpha + data[destinationOffset + 2] * inverseAlpha);
      data[destinationOffset + 3] = 255;
    }
  }

  return { data, height: baseRaster.height, width: baseRaster.width };
}

function addVerifiedBrandLogo(raster, payload, decodeSymbols) {
  for (const ratio of BRAND_LOGO_RATIOS) {
    const candidate = overlayLogo(raster, ratio);
    try {
      const symbols = decodeSymbols(candidate);
      if (Array.isArray(symbols) && symbols.length === 1 && symbols[0] === payload) {
        return candidate;
      }
    } catch {
      // Retry with a smaller logo while keeping the same QR payload.
    }
    candidate.data.fill(0);
  }
  raster.data.fill(0);
  fail("QR_BRAND", "엄지왕 로고를 포함한 QR을 안전하게 만들지 못했습니다.");
}

export function decodeQrSymbols(image) {
  validateQrImage(image);
  const luminances = grayscale(image);
  const detected = new Detector().detect(binarize(luminances, image.width, image.height));
  const decoder = new Decoder();
  const symbols = [];
  let current = detected.next();
  let attempts = 0;
  while (!current.done && attempts < 24) {
    attempts += 1;
    let succeeded = false;
    try {
      symbols.push(decoder.decode(current.value.matrix).content);
      succeeded = true;
    } catch {
      // Finder-like detector candidates are skipped within the fixed attempt bound.
    }
    current = detected.next(succeeded);
  }
  if (!current.done) fail("QR_VERIFY", "생성한 QR을 제한 안에서 다시 확인하지 못했습니다.");
  return symbols;
}

export function verifyQrRasterPayload(image, expectedPayload) {
  let symbols;
  try {
    if (typeof expectedPayload !== "string" || expectedPayload.length < 1) {
      fail("QR_INPUT", "확인할 QR 원문을 확인하지 못했습니다.");
    }
    symbols = decodeQrSymbols(image);
  } catch (error) {
    image?.data?.fill?.(0);
    if (error instanceof VerifiedQrError) throw error;
    fail("QR_VERIFY", "생성한 QR을 다시 읽지 못했습니다.");
  }
  if (symbols.length !== 1 || symbols[0] !== expectedPayload) {
    image?.data?.fill?.(0);
    fail("QR_VERIFY", "생성한 QR과 원문이 정확히 일치하지 않습니다.");
  }
  return true;
}

export function createVerifiedTextQr(payload, options = {}) {
  const {
    decodeSymbols,
    level,
    maximumLength,
    maximumPixelSize,
    quietZoneModules,
  } = validateGenerationOptions(options);
  if (typeof payload !== "string" || payload.length < 1 || payload.length > maximumLength) {
    fail("QR_INPUT", "QR 원문 길이를 확인해 주세요.");
  }
  let encoded;
  try {
    encoded = new Encoder({ level }).encode(createByteSegment(payload));
  } catch {
    fail("QR_ENCODE", "요청 QR을 만들지 못했습니다.");
  }
  const raster = renderRaster(encoded, maximumPixelSize, quietZoneModules);
  let symbols;
  try {
    symbols = decodeSymbols(raster);
  } catch (error) {
    raster.data.fill(0);
    if (error instanceof VerifiedQrError) throw error;
    fail("QR_VERIFY", "생성한 QR을 다시 읽지 못했습니다.");
  }
  if (!Array.isArray(symbols) || symbols.length !== 1 || symbols[0] !== payload) {
    raster.data.fill(0);
    fail("QR_VERIFY", "생성한 QR과 원문이 정확히 일치하지 않습니다.");
  }

  const branded = addVerifiedBrandLogo(raster, payload, decodeSymbols);
  raster.data.fill(0);
  return {
    data: branded.data,
    height: branded.height,
    payload,
    width: branded.width,
  };
}

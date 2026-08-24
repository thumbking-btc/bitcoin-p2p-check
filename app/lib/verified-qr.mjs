import { binarize, Byte, Charset, Decoder, Detector, Encoder, grayscale } from "@nuintun/qrcode";

const MAXIMUM_QR_PIXEL_SIZE = 2_048;
const MAXIMUM_QR_SCAN_DIMENSION = 4_096;
const QR_LEVELS = new Set(["L", "M", "Q", "H"]);

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
  return {
    data: raster.data,
    height: raster.height,
    payload,
    width: raster.width,
  };
}

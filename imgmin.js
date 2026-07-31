/*
 * imgmin.js - client side image compression
 *
 * JPEG / WebP go through the canvas encoder (lossy, quality controlled).
 * PNG is handled by a built in quantizer + PNG8 encoder, because
 * canvas.toDataURL('image/png', quality) ignores the quality argument and
 * re-encodes at 32bpp, which usually makes the file *bigger* than the source.
 */
var Imgmin = (function () {
  'use strict';

  var MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  var PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

  /* ------------------------------------------------------------------ *
   * capabilities
   * ------------------------------------------------------------------ */

  var webpSupported = null;
  function supportsWebP() {
    if (webpSupported === null) {
      var c = document.createElement('canvas');
      c.width = c.height = 1;
      webpSupported = c.toDataURL(MIME.webp).indexOf('data:' + MIME.webp) === 0;
    }
    return webpSupported;
  }

  // PNG8 needs a real zlib stream for IDAT. CompressionStream gives us one.
  var canDeflate = typeof CompressionStream === 'function';

  /* ------------------------------------------------------------------ *
   * decoding / drawing
   * ------------------------------------------------------------------ */

  // Returns a drawable source. The caller must call release() when done so
  // the object URL / ImageBitmap is not leaked.
  function loadSource(file) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file).then(function (bitmap) {
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          release: function () { if (bitmap.close) bitmap.close(); }
        };
      }).catch(function () { return loadViaImageElement(file); });
    }
    return loadViaImageElement(file);
  }

  function loadViaImageElement(file) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.src = url;
    // decode() resolves only once the pixels are actually available - this is
    // what guarantees naturalWidth/naturalHeight are non-zero before we draw.
    var ready = img.decode ? img.decode() : new Promise(function (resolve, reject) {
      img.onload = resolve;
      img.onerror = function () { reject(new Error('Could not decode image')); };
    });
    return ready.then(function () {
      return {
        source: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        release: function () { URL.revokeObjectURL(url); }
      };
    }).catch(function (err) {
      URL.revokeObjectURL(url);
      throw err;
    });
  }

  function toBlob(canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        blob ? resolve(blob) : reject(new Error('Encoding to ' + mime + ' failed'));
      }, mime, quality);
    });
  }

  /* ------------------------------------------------------------------ *
   * PNG8: colour quantization
   * ------------------------------------------------------------------ */

  function clamp255(v) {
    v = Math.round(v);
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  // Histogram at reduced precision (5 bits RGB, 4 bits alpha) so median cut
  // stays fast on photos, but each bucket keeps full precision sums so the
  // representative colour is still accurate.
  function histogram(data, pixels) {
    var buckets = new Map();
    var transparent = false;
    for (var p = 0, i = 0; p < pixels; p++, i += 4) {
      var a = data[i + 3];
      if (a === 0) { transparent = true; continue; }
      var r = data[i], g = data[i + 1], b = data[i + 2];
      var key = ((r >> 3) << 14) | ((g >> 3) << 9) | ((b >> 3) << 4) | (a >> 4);
      var e = buckets.get(key);
      if (e) {
        e.count++; e.rs += r; e.gs += g; e.bs += b; e.as += a;
      } else {
        buckets.set(key, { count: 1, rs: r, gs: g, bs: b, as: a });
      }
    }
    var entries = [];
    buckets.forEach(function (e) {
      entries.push({
        r: e.rs / e.count, g: e.gs / e.count,
        b: e.bs / e.count, a: e.as / e.count,
        count: e.count
      });
    });
    return { entries: entries, transparent: transparent };
  }

  var CHANNELS = ['r', 'g', 'b', 'a'];

  function makeBox(list) {
    var lo = [255, 255, 255, 255], hi = [0, 0, 0, 0], count = 0;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      count += c.count;
      for (var k = 0; k < 4; k++) {
        var v = c[CHANNELS[k]];
        if (v < lo[k]) lo[k] = v;
        if (v > hi[k]) hi[k] = v;
      }
    }
    // Weight the spread the way the eye sees it, so we do not waste palette
    // slots splitting blues while greens band.
    var weight = [2, 4, 1, 3], best = -1, ch = 0;
    for (var k2 = 0; k2 < 4; k2++) {
      var span = (hi[k2] - lo[k2]) * weight[k2];
      if (span > best) { best = span; ch = k2; }
    }
    return { list: list, channel: CHANNELS[ch], score: best * Math.log(count + 1), count: count };
  }

  function medianCut(entries, maxColors) {
    var boxes = [makeBox(entries)];
    while (boxes.length < maxColors) {
      var target = -1, best = 0;
      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].list.length < 2) continue;
        if (boxes[i].score > best) { best = boxes[i].score; target = i; }
      }
      if (target < 0) break;

      var box = boxes[target];
      var ch = box.channel;
      var list = box.list.slice().sort(function (x, y) { return x[ch] - y[ch]; });

      // Split at the weighted median so both halves carry similar pixel mass.
      var half = box.count / 2, acc = 0, cut = 0;
      for (var j = 0; j < list.length - 1; j++) {
        acc += list[j].count;
        if (acc >= half) { cut = j + 1; break; }
      }
      if (cut <= 0 || cut >= list.length) cut = list.length >> 1;

      boxes.splice(target, 1, makeBox(list.slice(0, cut)), makeBox(list.slice(cut)));
    }

    return boxes.map(function (box) {
      var rs = 0, gs = 0, bs = 0, as = 0, n = 0;
      for (var i = 0; i < box.list.length; i++) {
        var c = box.list[i];
        rs += c.r * c.count; gs += c.g * c.count;
        bs += c.b * c.count; as += c.a * c.count; n += c.count;
      }
      return [clamp255(rs / n), clamp255(gs / n), clamp255(bs / n), clamp255(as / n)];
    });
  }

  function buildPalette(data, pixels, maxColors) {
    var hist = histogram(data, pixels);
    var reserve = hist.transparent ? 1 : 0;
    var palette;

    if (hist.entries.length === 0) {
      palette = [];
    } else if (hist.entries.length <= maxColors - reserve) {
      palette = hist.entries.map(function (e) {
        return [clamp255(e.r), clamp255(e.g), clamp255(e.b), clamp255(e.a)];
      });
    } else {
      palette = medianCut(hist.entries, Math.max(1, maxColors - reserve));
    }

    if (hist.transparent) palette.unshift([0, 0, 0, 0]);
    if (palette.length === 0) palette.push([0, 0, 0, 0]);

    // tRNS must cover a contiguous run from index 0, so put the translucent
    // entries first - that keeps the chunk as short as possible.
    palette.sort(function (x, y) { return x[3] - y[3]; });
    return { palette: palette, hasTransparent: hist.transparent };
  }

  // 18 bit lookup cache (5/5/5 RGB + 3 bit alpha) so we do not run a full
  // palette scan for every pixel.
  function makeMatcher(palette) {
    var cache = new Int16Array(1 << 18).fill(-1);

    function scan(r, g, b, a) {
      var best = 0, bestD = Infinity;
      for (var i = 0; i < palette.length; i++) {
        var p = palette[i];
        var da = a - p[3];
        var d = da * da * 3;
        if (d >= bestD) continue;
        var dr = r - p[0], dg = g - p[1], db = b - p[2];
        d += dr * dr * 2 + dg * dg * 4 + db * db;
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    return function (r, g, b, a) {
      var key = ((r >> 3) << 13) | ((g >> 3) << 8) | ((b >> 3) << 3) | (a >> 5);
      var hit = cache[key];
      if (hit >= 0) return hit;
      var idx = scan(r, g, b, a);
      cache[key] = idx;
      return idx;
    };
  }

  function mapPixels(data, width, height, palette, transparentIndex, dither) {
    var pixels = width * height;
    var indices = new Uint8Array(pixels);
    var match = makeMatcher(palette);

    if (!dither) {
      for (var p = 0, i = 0; p < pixels; p++, i += 4) {
        var a = data[i + 3];
        indices[p] = a === 0 ? transparentIndex : match(data[i], data[i + 1], data[i + 2], a);
      }
      return indices;
    }

    // Floyd-Steinberg, serpentine. Alpha is left untouched - diffusing error
    // into it produces speckled edges.
    var buf = new Float32Array(pixels * 3);
    for (var q = 0, j = 0; q < pixels; q++, j += 4) {
      buf[q * 3] = data[j];
      buf[q * 3 + 1] = data[j + 1];
      buf[q * 3 + 2] = data[j + 2];
    }

    function diffuse(x, y, er, eg, eb, f) {
      if (x < 0 || x >= width || y >= height) return;
      var o = (y * width + x) * 3;
      buf[o] += er * f; buf[o + 1] += eg * f; buf[o + 2] += eb * f;
    }

    for (var y = 0; y < height; y++) {
      var reverse = (y & 1) === 1;
      var dir = reverse ? -1 : 1;
      for (var k = 0; k < width; k++) {
        var x = reverse ? width - 1 - k : k;
        var pi = y * width + x, di = pi * 4, bi = pi * 3;
        var av = data[di + 3];
        if (av === 0) { indices[pi] = transparentIndex; continue; }

        var r = clamp255(buf[bi]), g = clamp255(buf[bi + 1]), b = clamp255(buf[bi + 2]);
        var idx = match(r, g, b, av);
        indices[pi] = idx;

        var pe = palette[idx];
        var er = r - pe[0], eg = g - pe[1], eb = b - pe[2];
        diffuse(x + dir, y, er, eg, eb, 7 / 16);
        diffuse(x - dir, y + 1, er, eg, eb, 3 / 16);
        diffuse(x, y + 1, er, eg, eb, 5 / 16);
        diffuse(x + dir, y + 1, er, eg, eb, 1 / 16);
      }
    }
    return indices;
  }

  /* ------------------------------------------------------------------ *
   * PNG8: container
   * ------------------------------------------------------------------ */

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function chunk(type, data) {
    var out = new Uint8Array(data.length + 12);
    var view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(data.length + 8, crc32(out.subarray(4, data.length + 8)));
    return out;
  }

  function concat(parts) {
    var total = 0, i;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    for (i = 0, total = 0; i < parts.length; i++) {
      out.set(parts[i], total);
      total += parts[i].length;
    }
    return out;
  }

  function deflate(bytes) {
    // CompressionStream('deflate') emits a zlib stream, which is exactly the
    // format IDAT expects.
    var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Response(stream).arrayBuffer().then(function (buf) {
      return new Uint8Array(buf);
    });
  }

  function buildPNG8(width, height, palette, indices) {
    // Fewer colours means fewer bits per pixel - a big win for logos and icons.
    var depth = palette.length <= 2 ? 1 : palette.length <= 4 ? 2 : palette.length <= 16 ? 4 : 8;
    var perByte = 8 / depth;
    var rowBytes = Math.ceil(width / perByte);
    var raw = new Uint8Array((rowBytes + 1) * height);

    for (var y = 0, o = 0; y < height; y++) {
      raw[o++] = 0; // filter: None. Indexed data does not benefit from the others.
      if (depth === 8) {
        raw.set(indices.subarray(y * width, (y + 1) * width), o);
      } else {
        for (var x = 0; x < width; x++) {
          var shift = 8 - depth - (x % perByte) * depth;
          raw[o + ((x / perByte) | 0)] |= indices[y * width + x] << shift;
        }
      }
      o += rowBytes;
    }

    return deflate(raw).then(function (idat) {
      var ihdr = new Uint8Array(13);
      var view = new DataView(ihdr.buffer);
      view.setUint32(0, width);
      view.setUint32(4, height);
      ihdr[8] = depth;
      ihdr[9] = 3; // colour type 3 = indexed
      ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

      var plte = new Uint8Array(palette.length * 3);
      var trnsLen = 0;
      for (var i = 0; i < palette.length; i++) {
        plte[i * 3] = palette[i][0];
        plte[i * 3 + 1] = palette[i][1];
        plte[i * 3 + 2] = palette[i][2];
        if (palette[i][3] < 255) trnsLen = i + 1;
      }

      var parts = [new Uint8Array(PNG_SIG), chunk('IHDR', ihdr), chunk('PLTE', plte)];
      if (trnsLen) {
        var trns = new Uint8Array(trnsLen);
        for (var t = 0; t < trnsLen; t++) trns[t] = palette[t][3];
        parts.push(chunk('tRNS', trns));
      }
      parts.push(chunk('IDAT', idat), chunk('IEND', new Uint8Array(0)));
      return new Blob([concat(parts)], { type: MIME.png });
    });
  }

  function encodePNG(canvas, ctx, quality, dither) {
    if (!canDeflate) return toBlob(canvas, MIME.png); // no zlib available
    var maxColors = Math.max(2, Math.min(256, Math.round((quality / 100) * 254) + 2));
    var image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var built = buildPalette(image.data, canvas.width * canvas.height, maxColors);
    // Palette is sorted by alpha, so when the image has any fully transparent
    // pixel its entry is always index 0.
    var indices = mapPixels(
      image.data, canvas.width, canvas.height, built.palette, 0, dither
    );
    return buildPNG8(canvas.width, canvas.height, built.palette, indices);
  }

  /* ------------------------------------------------------------------ *
   * public API
   * ------------------------------------------------------------------ */

  function extensionOf(name) {
    var dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  function resolveFormat(file, preference) {
    if (preference === 'webp') return supportsWebP() ? 'webp' : 'jpeg';
    if (preference === 'jpeg') return 'jpeg';
    if (preference === 'png') return 'png';

    var type = (file.type || '').toLowerCase() || extensionOf(file.name);
    if (type.indexOf('png') >= 0) return 'png';
    if (type.indexOf('webp') >= 0) return supportsWebP() ? 'webp' : 'jpeg';
    return 'jpeg';
  }

  function renameTo(name, format) {
    var dot = name.lastIndexOf('.');
    var base = dot > 0 ? name.slice(0, dot) : name;
    return base + '.' + (format === 'jpeg' ? 'jpg' : format);
  }

  function compress(file, options) {
    var opts = options || {};
    var quality = typeof opts.quality === 'number' ? opts.quality : 60;
    var dither = !!opts.dither;

    return loadSource(file).then(function (src) {
      try {
        var width = src.width, height = src.height;
        if (!width || !height) throw new Error('Image reported zero dimensions');

        var format = resolveFormat(file, opts.format || 'auto');
        var opaque = format === 'jpeg';

        var canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        var ctx = canvas.getContext('2d', { willReadFrequently: format === 'png' });

        // JPEG has no alpha channel. Without this, every transparent pixel
        // decodes as black - the "dark background" problem.
        if (opaque) {
          ctx.fillStyle = opts.background || '#ffffff';
          ctx.fillRect(0, 0, width, height);
        }
        ctx.drawImage(src.source, 0, 0);

        var encoded = format === 'png'
          ? encodePNG(canvas, ctx, quality, dither)
          : toBlob(canvas, MIME[format], quality / 100);

        return encoded.then(function (blob) {
          // Re-encoding can grow a file that was already well optimised.
          // Handing back something bigger is never the right answer.
          var grew = blob.size >= file.size;
          var finalBlob = grew ? file : blob;
          var finalFormat = grew ? resolveFormat(file, 'auto') : format;
          return {
            blob: finalBlob,
            url: URL.createObjectURL(finalBlob),
            name: grew ? file.name : renameTo(file.name, format),
            format: finalFormat,
            width: width,
            height: height,
            size: finalBlob.size,
            originalSize: file.size,
            skipped: grew
          };
        });
      } finally {
        src.release();
      }
    });
  }

  return {
    compress: compress,
    supportsWebP: supportsWebP,
    supportsPNG8: function () { return canDeflate; }
  };
})();

/*
 * Back-compat shim for the old synchronous jic.compress(imageElement, ...).
 * Kept only so older pages in this folder keep working - new code should call
 * Imgmin.compress(file, options), which is async and never races the decoder.
 */
var jic = {
  compress: function (imageElement, qualityPercentage, fileType) {
    var mimeType = fileType === 'png' ? 'image/png' : 'image/jpeg';
    var canvas = document.createElement('canvas');
    canvas.width = imageElement.naturalWidth || imageElement.width;
    canvas.height = imageElement.naturalHeight || imageElement.height;
    if (!canvas.width || !canvas.height) {
      throw new Error('jic.compress: image is not decoded yet - wait for onload/decode()');
    }
    var context = canvas.getContext('2d');
    if (mimeType === 'image/jpeg') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(imageElement, 0, 0);
    var out = new Image();
    out.src = canvas.toDataURL(mimeType, qualityPercentage / 100);
    return out;
  }
};

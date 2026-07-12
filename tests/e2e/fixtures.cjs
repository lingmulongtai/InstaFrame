const jpeg = require('jpeg-js');
const piexif = require('piexifjs');

function createJpeg({ gps = false, colorShift = 0 } = {}) {
  const width = 480;
  const height = 320;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = (40 + x / 3 + colorShift) % 255;
      data[offset + 1] = (70 + y / 2) % 255;
      data[offset + 2] = (150 + x / 5) % 255;
      data[offset + 3] = 255;
    }
  }

  const encoded = jpeg.encode({ data, width, height }, 88).data;
  const zeroth = {
    [piexif.ImageIFD.Make]: 'FUJIFILM',
    [piexif.ImageIFD.Model]: 'X-T5',
  };
  const exif = {
    [piexif.ExifIFD.LensModel]: 'XF35mmF1.4 R',
    [piexif.ExifIFD.FocalLength]: [35, 1],
    [piexif.ExifIFD.FNumber]: [14, 10],
    [piexif.ExifIFD.ExposureTime]: [1, 250],
    [piexif.ExifIFD.ISOSpeedRatings]: 400,
  };
  const gpsData = gps ? {
    [piexif.GPSIFD.GPSLatitudeRef]: 'N',
    [piexif.GPSIFD.GPSLatitude]: [[35, 1], [40, 1], [3432, 100]],
    [piexif.GPSIFD.GPSLongitudeRef]: 'E',
    [piexif.GPSIFD.GPSLongitude]: [[139, 1], [39, 1], [108, 100]],
  } : {};
  const exifBytes = piexif.dump({ '0th': zeroth, Exif: exif, GPS: gpsData });
  const dataUrl = `data:image/jpeg;base64,${encoded.toString('base64')}`;
  return Buffer.from(piexif.insert(exifBytes, dataUrl).split(',')[1], 'base64');
}

function createWebm() {
  return Buffer.from(
    'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwH/////////EU2bdKtNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEn7AEAAAAAAABoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjEuMS4xMDBXQYxMYXZmNjEuMS4xMDBEiYhAgsAAAAAAABZUrmvMrgEAAAAAAABD14EBc8WIpP1AKAfCbBCcgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QF9eEA4JSwgaC6gVqagQJVsIhVt4ECVbiBAhJUw2fWc3OfY8CAZ8iZRaOHRU5DT0RFUkSHjExhdmY2MS4xLjEwMHNzsWPAi2PFiKT9QCgHwmwQZ8igRaOHRU5DT0RFUkSHk0xhdmM2MS4zLjEwMCBsaWJ2cHgfQ7Z1QOjngQCj4YEAAIBwBgCdASqgAFoAAEcIhYWIhYSIAgICdaoD+AIGtCgCTAuEZ/I21FV8sA95P9G1FV8sA95P8/Rwkxn8rhxI/vOk//79pe+0vfaX+vb/96yvvWV98gf+9/wAAAAACyCjmIEAZAARAgABEBAAGAAYWC/0AAiAgQAAAKOYgQDIABECAAEQEAAYABhYL/QACICBAAAAo5iBASwAEQIAARAQABgAGFgv9AAIgIEAAACjmIEBkAARAgABEBAAGAAYWC/0AAiAgQAAAKOYgQH0ABECAAEQEAAYABhYL/QACICBAAAA',
    'base64',
  );
}

module.exports = { createJpeg, createWebm };

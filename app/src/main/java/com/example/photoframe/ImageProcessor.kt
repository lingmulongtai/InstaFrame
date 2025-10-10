package com.example.photoframe

import android.content.Context
import android.graphics.*
import android.net.Uri
import androidx.exifinterface.media.ExifInterface

object ImageProcessor {

    // Create a bitmap with a white frame and EXIF text underneath.
    // aspectRatio: width / height for the photo area (not counting text)
    suspend fun createFramedBitmap(context: Context, uri: Uri, aspectRatio: Float, showDate: Boolean, showCamera: Boolean): Bitmap? {
        try {
            val resolver = context.contentResolver
            resolver.openInputStream(uri).use { input ->
                if (input == null) return null
                // Decode original bitmap with reasonable sample to avoid OOM (simple approach)
                val options = BitmapFactory.Options()
                options.inSampleSize = 1
                val original = BitmapFactory.decodeStream(input, null, options) ?: return null

                // Read EXIF
                val exif = try {
                    resolver.openInputStream(uri)?.use { ExifInterface(it) }
                } catch (e: Exception) {
                    null
                }

                val date = exif?.getAttribute(ExifInterface.TAG_DATETIME)
                val camera = exif?.getAttribute(ExifInterface.TAG_MAKE)?.let { make ->
                    val model = exif.getAttribute(ExifInterface.TAG_MODEL)
                    listOfNotNull(make, model).joinToString(" ")
                }

                // Determine target sizes
                val frameThickness = (original.width * 0.03f).coerceAtLeast(8f)
                // Keep the width same as original for simplicity, compute photo height by aspect ratio
                val photoWidth = original.width
                val photoHeight = (photoWidth / aspectRatio).toInt()

                val textLines = mutableListOf<String>()
                if (showDate && date != null) textLines.add(date)
                if (showCamera && camera != null) textLines.add(camera)
                val caption = textLines.joinToString(" \n")

                // Calculate caption height
                val paint = Paint(Paint.ANTI_ALIAS_FLAG)
                paint.textSize = (photoWidth * 0.03f).coerceAtLeast(24f)
                paint.color = Color.BLACK
                val captionPadding = 16
                val fm = paint.fontMetrics
                val lineHeight = (fm.descent - fm.ascent).toInt()
                val captionLinesCount = if (caption.isBlank()) 0 else caption.split("\n").size
                val captionHeight = captionLinesCount * lineHeight + captionPadding * 2

                val outWidth = photoWidth + (frameThickness * 2).toInt()
                val outHeight = photoHeight + (frameThickness * 2).toInt() + captionHeight

                val outBitmap = Bitmap.createBitmap(outWidth, outHeight, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(outBitmap)
                canvas.drawColor(Color.WHITE)

                // Draw framed white border
                val innerLeft = frameThickness
                val innerTop = frameThickness
                val innerRight = outWidth - frameThickness
                val innerBottom = frameThickness + photoHeight

                // Draw photo background (white) and then the image centered-cropped into the photo area
                val photoRect = RectF(innerLeft, innerTop, innerRight.toFloat(), innerBottom.toFloat())

                val srcRect = getCropRectForAspect(original.width, original.height, photoRect.width().toInt(), photoRect.height().toInt())
                val dstRect = Rect(innerLeft.toInt(), innerTop.toInt(), innerRight.toInt(), innerBottom.toInt())
                val src = Rect(srcRect.left, srcRect.top, srcRect.right, srcRect.bottom)

                canvas.drawColor(Color.WHITE)

                val bmpPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
                canvas.drawBitmap(original, src, dstRect, bmpPaint)

                // Draw caption
                if (caption.isNotBlank()) {
                    paint.color = Color.BLACK
                    paint.textSize = (photoWidth * 0.03f).coerceAtLeast(24f)
                    // recompute font metrics in case textSize changed
                    val fm2 = paint.fontMetrics
                    val lineHeight2 = (fm2.descent - fm2.ascent).toInt()
                    paint.textAlign = Paint.Align.LEFT
                    val startX = frameThickness + captionPadding
                    var y = innerBottom + captionPadding - fm2.ascent
                    caption.split("\n").forEach { line ->
                        canvas.drawText(line, startX, y, paint)
                        y += lineHeight2
                    }
                }

                return outBitmap
            }
        } catch (e: Exception) {
            e.printStackTrace()
            return null
        }
    }

    private fun getCropRectForAspect(srcW: Int, srcH: Int, dstW: Int, dstH: Int): Rect {
        val srcRatio = srcW.toFloat() / srcH
        val dstRatio = dstW.toFloat() / dstH
        return if (srcRatio > dstRatio) {
            // source wider -> crop left/right
            val newWidth = (srcH * dstRatio).toInt()
            val left = (srcW - newWidth) / 2
            Rect(left, 0, left + newWidth, srcH)
        } else {
            // source taller -> crop top/bottom
            val newHeight = (srcW / dstRatio).toInt()
            val top = (srcH - newHeight) / 2
            Rect(0, top, srcW, top + newHeight)
        }
    }
}

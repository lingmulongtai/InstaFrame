package com.example.photoframe.processing

import android.graphics.*
import com.example.photoframe.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.*

/**
 * フレーム・ウォーターマーク・日付スタンプ処理エンジン
 */
object FrameEngine {

    /**
     * フレームを画像に適用
     */
    suspend fun applyFrame(
        bitmap: Bitmap,
        frameStyle: FrameStyle,
        exifData: ExifData? = null,
        watermarkConfig: WatermarkConfig? = null,
        dateStampStyle: DateStampStyle? = null
    ): Bitmap = withContext(Dispatchers.Default) {
        
        if (frameStyle.id == "none" && watermarkConfig?.enabled != true && dateStampStyle?.enabled != true) {
            return@withContext bitmap.copy(Bitmap.Config.ARGB_8888, true)
        }
        
        val originalWidth = bitmap.width
        val originalHeight = bitmap.height
        
        // フレームサイズ計算
        val borderWidth = (originalWidth * frameStyle.borderWidthRatio).toInt()
        val bottomExtra = (originalHeight * frameStyle.bottomExtraRatio).toInt()
        
        val newWidth = originalWidth + borderWidth * 2
        val newHeight = originalHeight + borderWidth * 2 + bottomExtra
        
        val result = Bitmap.createBitmap(newWidth, newHeight, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(result)
        
        // フレーム背景を描画
        val framePaint = Paint().apply {
            color = frameStyle.frameColor.toArgb()
            isAntiAlias = true
        }
        
        if (frameStyle.cornerRadius > 0) {
            val rect = RectF(0f, 0f, newWidth.toFloat(), newHeight.toFloat())
            canvas.drawRoundRect(rect, frameStyle.cornerRadius, frameStyle.cornerRadius, framePaint)
        } else {
            canvas.drawRect(0f, 0f, newWidth.toFloat(), newHeight.toFloat(), framePaint)
        }
        
        // 外側シャドウ
        if (frameStyle.outerShadow) {
            val shadowPaint = Paint().apply {
                color = Color.argb(30, 0, 0, 0)
                maskFilter = BlurMaskFilter(8f, BlurMaskFilter.Blur.OUTER)
            }
            canvas.drawRect(
                borderWidth.toFloat() - 4,
                borderWidth.toFloat() - 4,
                (newWidth - borderWidth).toFloat() + 4,
                (newHeight - borderWidth - bottomExtra).toFloat() + 4,
                shadowPaint
            )
        }
        
        // 元画像を描画
        val destRect = RectF(
            borderWidth.toFloat(),
            borderWidth.toFloat(),
            (newWidth - borderWidth).toFloat(),
            (newHeight - borderWidth - bottomExtra).toFloat()
        )
        
        val bitmapPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        
        if (frameStyle.cornerRadius > 0) {
            // 角丸クリッピング
            val path = Path().apply {
                addRoundRect(destRect, frameStyle.cornerRadius, frameStyle.cornerRadius, Path.Direction.CW)
            }
            canvas.save()
            canvas.clipPath(path)
            canvas.drawBitmap(bitmap, null, destRect, bitmapPaint)
            canvas.restore()
        } else {
            canvas.drawBitmap(bitmap, null, destRect, bitmapPaint)
        }
        
        // 内側シャドウ
        if (frameStyle.innerShadow) {
            val innerShadowPaint = Paint().apply {
                shader = LinearGradient(
                    destRect.left, destRect.top,
                    destRect.left, destRect.top + 30f,
                    Color.argb(40, 0, 0, 0),
                    Color.TRANSPARENT,
                    Shader.TileMode.CLAMP
                )
            }
            canvas.drawRect(destRect.left, destRect.top, destRect.right, destRect.top + 30f, innerShadowPaint)
        }
        
        // ウォーターマーク描画
        watermarkConfig?.let { config ->
            if (config.enabled) {
                drawWatermark(canvas, result, config, exifData)
            }
        }
        
        // 日付スタンプ描画
        dateStampStyle?.let { style ->
            if (style.enabled) {
                drawDateStamp(canvas, result, style, exifData?.dateTime)
            }
        }
        
        result
    }
    
    private fun drawWatermark(
        canvas: Canvas,
        bitmap: Bitmap,
        config: WatermarkConfig,
        exifData: ExifData?
    ) {
        val text = when (config.type) {
            WatermarkType.SHOT_ON -> buildShotOnText(config, exifData)
            WatermarkType.EXIF_FRAME -> buildExifFrameText(config, exifData)
            WatermarkType.DATE_STAMP -> exifData?.dateTime ?: ""
            WatermarkType.CUSTOM -> config.customText
        }
        
        if (text.isBlank()) return
        
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = config.textColor.toArgb()
            textSize = config.fontSize * bitmap.width / 400f
            alpha = (config.opacity * 255).toInt()
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.NORMAL)
        }
        
        val textBounds = Rect()
        paint.getTextBounds(text, 0, text.length, textBounds)
        
        val padding = bitmap.width * 0.03f
        val (x, y) = calculatePosition(
            config.position,
            bitmap.width.toFloat(),
            bitmap.height.toFloat(),
            textBounds.width().toFloat(),
            textBounds.height().toFloat(),
            padding
        )
        
        // テキスト背景（オプション）
        val bgPaint = Paint().apply {
            color = Color.argb(60, 0, 0, 0)
        }
        canvas.drawRoundRect(
            x - 8, y - textBounds.height() - 4,
            x + textBounds.width() + 8, y + 8,
            4f, 4f, bgPaint
        )
        
        canvas.drawText(text, x, y, paint)
    }
    
    private fun buildShotOnText(config: WatermarkConfig, exifData: ExifData?): String {
        val parts = mutableListOf<String>()
        
        if (config.showMake && !exifData?.make.isNullOrBlank()) {
            parts.add(exifData!!.make!!)
        }
        if (config.showModel && !exifData?.model.isNullOrBlank()) {
            // 重複除去（Makeに含まれるModelの場合）
            val model = exifData!!.model!!
            if (parts.isEmpty() || !parts.any { model.contains(it, ignoreCase = true) }) {
                parts.add(model)
            }
        }
        
        return if (parts.isNotEmpty()) {
            "Shot on ${parts.joinToString(" ")}"
        } else {
            ""
        }
    }
    
    private fun buildExifFrameText(config: WatermarkConfig, exifData: ExifData?): String {
        val parts = mutableListOf<String>()
        
        if (!exifData?.make.isNullOrBlank()) {
            parts.add(exifData!!.make!!)
        }
        if (!exifData?.model.isNullOrBlank()) {
            parts.add(exifData!!.model!!)
        }
        if (config.showLensInfo && !exifData?.lensModel.isNullOrBlank()) {
            parts.add(exifData!!.lensModel!!)
        }
        if (config.showSettings) {
            val settings = mutableListOf<String>()
            exifData?.focalLength?.let { settings.add("${it}mm") }
            exifData?.fNumber?.let { settings.add("f/$it") }
            exifData?.exposureTime?.let { settings.add(it) }
            exifData?.iso?.let { settings.add("ISO $it") }
            if (settings.isNotEmpty()) {
                parts.add(settings.joinToString(" | "))
            }
        }
        
        return parts.joinToString("\n")
    }
    
    private fun drawDateStamp(
        canvas: Canvas,
        bitmap: Bitmap,
        style: DateStampStyle,
        dateTime: String?
    ) {
        val dateText = try {
            val inputFormat = SimpleDateFormat("yyyy:MM:dd HH:mm:ss", Locale.US)
            val outputFormat = SimpleDateFormat(style.format.pattern, Locale.US)
            dateTime?.let {
                val date = inputFormat.parse(it)
                date?.let { d -> outputFormat.format(d) }
            } ?: SimpleDateFormat(style.format.pattern, Locale.US).format(Date())
        } catch (e: Exception) {
            SimpleDateFormat(style.format.pattern, Locale.US).format(Date())
        }
        
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = style.color.toArgb()
            textSize = style.fontSize * bitmap.width / 400f
            typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
        }
        
        val textBounds = Rect()
        paint.getTextBounds(dateText, 0, dateText.length, textBounds)
        
        val padding = bitmap.width * 0.04f
        val (x, y) = calculatePosition(
            style.position,
            bitmap.width.toFloat(),
            bitmap.height.toFloat(),
            textBounds.width().toFloat(),
            textBounds.height().toFloat(),
            padding
        )
        
        canvas.drawText(dateText, x, y, paint)
    }
    
    private fun calculatePosition(
        position: WatermarkPosition,
        canvasWidth: Float,
        canvasHeight: Float,
        textWidth: Float,
        textHeight: Float,
        padding: Float
    ): Pair<Float, Float> {
        return when (position) {
            WatermarkPosition.TOP_LEFT -> Pair(padding, padding + textHeight)
            WatermarkPosition.TOP_CENTER -> Pair((canvasWidth - textWidth) / 2, padding + textHeight)
            WatermarkPosition.TOP_RIGHT -> Pair(canvasWidth - textWidth - padding, padding + textHeight)
            WatermarkPosition.BOTTOM_LEFT -> Pair(padding, canvasHeight - padding)
            WatermarkPosition.BOTTOM_CENTER -> Pair((canvasWidth - textWidth) / 2, canvasHeight - padding)
            WatermarkPosition.BOTTOM_RIGHT -> Pair(canvasWidth - textWidth - padding, canvasHeight - padding)
        }
    }
    
    private fun androidx.compose.ui.graphics.Color.toArgb(): Int {
        return android.graphics.Color.argb(
            (alpha * 255).toInt(),
            (red * 255).toInt(),
            (green * 255).toInt(),
            (blue * 255).toInt()
        )
    }
}

/**
 * EXIF情報データクラス
 */
data class ExifData(
    val make: String? = null,
    val model: String? = null,
    val lensModel: String? = null,
    val focalLength: String? = null,
    val fNumber: String? = null,
    val exposureTime: String? = null,
    val iso: Int? = null,
    val dateTime: String? = null
)

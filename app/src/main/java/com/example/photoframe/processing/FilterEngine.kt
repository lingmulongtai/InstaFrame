package com.example.photoframe.processing

import android.graphics.*
import com.example.photoframe.data.FilterPreset
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

/**
 * フィルム風フィルターエンジン
 * Liitのようなヴィンテージ・フィルム感を再現
 */
object FilterEngine {

    /**
     * フィルタープリセットを画像に適用
     */
    suspend fun applyFilter(
        bitmap: Bitmap,
        filter: FilterPreset
    ): Bitmap = withContext(Dispatchers.Default) {
        if (filter.id == "original") return@withContext bitmap.copy(Bitmap.Config.ARGB_8888, true)
        
        val result = bitmap.copy(Bitmap.Config.ARGB_8888, true)
        val width = result.width
        val height = result.height
        val pixels = IntArray(width * height)
        result.getPixels(pixels, 0, width, 0, 0, width, height)
        
        // 基本調整を適用
        applyBasicAdjustments(pixels, filter)
        
        // フェード効果
        if (filter.fade > 0f) {
            applyFade(pixels, filter.fade)
        }
        
        // カラーオーバーレイ
        filter.overlayColor?.let { color ->
            if (filter.overlayIntensity > 0f) {
                applyColorOverlay(pixels, color, filter.overlayIntensity)
            }
        }
        
        result.setPixels(pixels, 0, width, 0, 0, width, height)
        
        // グレイン効果
        if (filter.grain > 0f) {
            applyGrain(result, filter.grain)
        }
        
        // ビネット効果
        if (filter.vignette > 0f) {
            applyVignette(result, filter.vignette)
        }
        
        // ダスト効果
        if (filter.dustAmount > 0f) {
            applyDust(result, filter.dustAmount)
        }
        
        result
    }
    
    private fun applyBasicAdjustments(pixels: IntArray, filter: FilterPreset) {
        for (i in pixels.indices) {
            var r = Color.red(pixels[i]).toFloat()
            var g = Color.green(pixels[i]).toFloat()
            var b = Color.blue(pixels[i]).toFloat()
            val a = Color.alpha(pixels[i])
            
            // 露出
            if (filter.exposure != 0f) {
                val factor = 1f + filter.exposure
                r *= factor
                g *= factor
                b *= factor
            }
            
            // 明るさ
            if (filter.brightness != 0f) {
                val adjustment = filter.brightness * 255f
                r += adjustment
                g += adjustment
                b += adjustment
            }
            
            // コントラスト
            if (filter.contrast != 1f) {
                val factor = filter.contrast
                r = ((r - 128f) * factor + 128f)
                g = ((g - 128f) * factor + 128f)
                b = ((b - 128f) * factor + 128f)
            }
            
            // 色温度 (暖色/寒色)
            if (filter.temperature != 0f) {
                val temp = filter.temperature * 30f
                r += temp
                b -= temp
            }
            
            // 色相 (マゼンタ/グリーン)
            if (filter.tint != 0f) {
                val tint = filter.tint * 30f
                g -= tint
            }
            
            // 彩度
            if (filter.saturation != 1f) {
                val gray = 0.299f * r + 0.587f * g + 0.114f * b
                r = gray + (r - gray) * filter.saturation
                g = gray + (g - gray) * filter.saturation
                b = gray + (b - gray) * filter.saturation
            }
            
            // ハイライト
            if (filter.highlights != 0f) {
                val luminance = 0.299f * r + 0.587f * g + 0.114f * b
                if (luminance > 180f) {
                    val factor = 1f + filter.highlights * (luminance / 255f)
                    r *= factor
                    g *= factor
                    b *= factor
                }
            }
            
            // シャドウ
            if (filter.shadows != 0f) {
                val luminance = 0.299f * r + 0.587f * g + 0.114f * b
                if (luminance < 75f) {
                    val factor = 1f + filter.shadows * (1f - luminance / 75f)
                    r *= factor
                    g *= factor
                    b *= factor
                }
            }
            
            // クランプ
            pixels[i] = Color.argb(
                a,
                r.toInt().coerceIn(0, 255),
                g.toInt().coerceIn(0, 255),
                b.toInt().coerceIn(0, 255)
            )
        }
    }
    
    private fun applyFade(pixels: IntArray, amount: Float) {
        val fadeLevel = (amount * 40f).toInt()
        for (i in pixels.indices) {
            val r = (Color.red(pixels[i]) + fadeLevel).coerceIn(0, 255)
            val g = (Color.green(pixels[i]) + fadeLevel).coerceIn(0, 255)
            val b = (Color.blue(pixels[i]) + fadeLevel).coerceIn(0, 255)
            pixels[i] = Color.argb(Color.alpha(pixels[i]), r, g, b)
        }
    }
    
    private fun applyColorOverlay(pixels: IntArray, color: androidx.compose.ui.graphics.Color, intensity: Float) {
        val overlayR = (color.red * 255).toInt()
        val overlayG = (color.green * 255).toInt()
        val overlayB = (color.blue * 255).toInt()
        
        for (i in pixels.indices) {
            val r = ((1 - intensity) * Color.red(pixels[i]) + intensity * overlayR).toInt().coerceIn(0, 255)
            val g = ((1 - intensity) * Color.green(pixels[i]) + intensity * overlayG).toInt().coerceIn(0, 255)
            val b = ((1 - intensity) * Color.blue(pixels[i]) + intensity * overlayB).toInt().coerceIn(0, 255)
            pixels[i] = Color.argb(Color.alpha(pixels[i]), r, g, b)
        }
    }
    
    private fun applyGrain(bitmap: Bitmap, amount: Float) {
        val canvas = Canvas(bitmap)
        val paint = Paint()
        val random = Random(System.currentTimeMillis())
        val width = bitmap.width
        val height = bitmap.height
        val grainIntensity = (amount * 50f).toInt()
        
        // グレインのドット数を調整
        val dotCount = ((width * height) * amount * 0.05f).toInt()
        
        for (i in 0 until dotCount) {
            val x = random.nextFloat() * width
            val y = random.nextFloat() * height
            val brightness = random.nextInt(-grainIntensity, grainIntensity + 1)
            val alpha = (amount * 80f).toInt()
            
            paint.color = if (brightness > 0) {
                Color.argb(alpha, 255, 255, 255)
            } else {
                Color.argb(alpha, 0, 0, 0)
            }
            
            canvas.drawCircle(x, y, 1f, paint)
        }
    }
    
    private fun applyVignette(bitmap: Bitmap, amount: Float) {
        val canvas = Canvas(bitmap)
        val width = bitmap.width.toFloat()
        val height = bitmap.height.toFloat()
        val centerX = width / 2f
        val centerY = height / 2f
        val radius = Math.max(width, height) * (0.7f - amount * 0.3f)
        
        val gradient = RadialGradient(
            centerX, centerY,
            radius,
            intArrayOf(
                Color.TRANSPARENT,
                Color.TRANSPARENT,
                Color.argb((amount * 200).toInt(), 0, 0, 0)
            ),
            floatArrayOf(0f, 0.5f, 1f),
            Shader.TileMode.CLAMP
        )
        
        val paint = Paint().apply {
            shader = gradient
            isAntiAlias = true
        }
        
        canvas.drawRect(0f, 0f, width, height, paint)
    }
    
    private fun applyDust(bitmap: Bitmap, amount: Float) {
        val canvas = Canvas(bitmap)
        val paint = Paint().apply {
            isAntiAlias = true
        }
        val random = Random(42)  // 固定シードで再現性確保
        val width = bitmap.width
        val height = bitmap.height
        
        // ダストスポット
        val spotCount = (amount * 20).toInt()
        for (i in 0 until spotCount) {
            val x = random.nextFloat() * width
            val y = random.nextFloat() * height
            val size = random.nextFloat() * 3f + 1f
            val alpha = (random.nextFloat() * 60f * amount).toInt()
            
            paint.color = Color.argb(alpha, 240, 230, 200)
            canvas.drawCircle(x, y, size, paint)
        }
        
        // ライトリーク風（オプション）
        if (amount > 0.5f) {
            val leakPaint = Paint().apply {
                shader = LinearGradient(
                    0f, 0f, width * 0.3f, height.toFloat(),
                    Color.argb(((amount - 0.5f) * 40).toInt(), 255, 200, 100),
                    Color.TRANSPARENT,
                    Shader.TileMode.CLAMP
                )
            }
            canvas.drawRect(0f, 0f, width * 0.3f, height.toFloat(), leakPaint)
        }
    }
}

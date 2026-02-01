package com.example.photoframe.processing

import android.graphics.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * プロレベル編集機能エンジン
 * HSL調整、トーンカーブ、その他高度な編集機能を提供
 */
object EditEngine {

    /**
     * 編集パラメータ
     */
    data class EditParams(
        // 基本調整
        val brightness: Float = 0f,      // -1.0 to 1.0
        val contrast: Float = 1f,        // 0.0 to 2.0
        val saturation: Float = 1f,      // 0.0 to 2.0
        val exposure: Float = 0f,        // -2.0 to 2.0
        
        // 色温度・色相
        val temperature: Float = 0f,     // -1.0 (cool) to 1.0 (warm)
        val tint: Float = 0f,            // -1.0 (green) to 1.0 (magenta)
        val vibrance: Float = 0f,        // -1.0 to 1.0
        
        // トーン調整
        val highlights: Float = 0f,      // -1.0 to 1.0
        val shadows: Float = 0f,         // -1.0 to 1.0
        val whites: Float = 0f,          // -1.0 to 1.0
        val blacks: Float = 0f,          // -1.0 to 1.0
        
        // HSL個別調整 (各色相ごと)
        val hslAdjustments: Map<HueRange, HSLAdjustment> = emptyMap(),
        
        // シャープネス・ノイズ
        val sharpness: Float = 0f,       // 0.0 to 1.0
        val noiseReduction: Float = 0f,  // 0.0 to 1.0
        
        // その他
        val clarity: Float = 0f,         // -1.0 to 1.0
        val dehaze: Float = 0f           // -1.0 to 1.0
    )
    
    /**
     * 色相範囲
     */
    enum class HueRange(val minHue: Float, val maxHue: Float) {
        RED(330f, 30f),
        ORANGE(15f, 45f),
        YELLOW(45f, 75f),
        GREEN(75f, 165f),
        CYAN(165f, 195f),
        BLUE(195f, 255f),
        PURPLE(255f, 285f),
        MAGENTA(285f, 330f)
    }
    
    /**
     * HSL個別調整
     */
    data class HSLAdjustment(
        val hueShift: Float = 0f,        // -30 to 30
        val saturation: Float = 0f,      // -1.0 to 1.0
        val luminance: Float = 0f        // -1.0 to 1.0
    )
    
    /**
     * 編集パラメータを画像に適用
     */
    suspend fun applyEdits(
        bitmap: Bitmap,
        params: EditParams
    ): Bitmap = withContext(Dispatchers.Default) {
        val result = bitmap.copy(Bitmap.Config.ARGB_8888, true)
        val width = result.width
        val height = result.height
        val pixels = IntArray(width * height)
        result.getPixels(pixels, 0, width, 0, 0, width, height)
        
        for (i in pixels.indices) {
            var r = Color.red(pixels[i]).toFloat()
            var g = Color.green(pixels[i]).toFloat()
            var b = Color.blue(pixels[i]).toFloat()
            val a = Color.alpha(pixels[i])
            
            // 露出
            if (params.exposure != 0f) {
                val factor = Math.pow(2.0, params.exposure.toDouble()).toFloat()
                r *= factor
                g *= factor
                b *= factor
            }
            
            // 明るさ
            if (params.brightness != 0f) {
                val adjustment = params.brightness * 255f
                r += adjustment
                g += adjustment
                b += adjustment
            }
            
            // コントラスト
            if (params.contrast != 1f) {
                r = (r - 128f) * params.contrast + 128f
                g = (g - 128f) * params.contrast + 128f
                b = (b - 128f) * params.contrast + 128f
            }
            
            // 色温度
            if (params.temperature != 0f) {
                val temp = params.temperature * 40f
                r += temp
                b -= temp
            }
            
            // ティント
            if (params.tint != 0f) {
                val tint = params.tint * 40f
                g -= tint
            }
            
            // 彩度
            if (params.saturation != 1f) {
                val gray = 0.299f * r + 0.587f * g + 0.114f * b
                r = gray + (r - gray) * params.saturation
                g = gray + (g - gray) * params.saturation
                b = gray + (b - gray) * params.saturation
            }
            
            // バイブランス（低彩度部分を優先的に彩度アップ）
            if (params.vibrance != 0f) {
                val max = maxOf(r, g, b)
                val min = minOf(r, g, b)
                val currentSat = if (max > 0) (max - min) / max else 0f
                val vibranceFactor = 1f + params.vibrance * (1f - currentSat)
                val gray = 0.299f * r + 0.587f * g + 0.114f * b
                r = gray + (r - gray) * vibranceFactor
                g = gray + (g - gray) * vibranceFactor
                b = gray + (b - gray) * vibranceFactor
            }
            
            // ハイライト
            if (params.highlights != 0f) {
                val luminance = 0.299f * r + 0.587f * g + 0.114f * b
                if (luminance > 180f) {
                    val weight = (luminance - 180f) / 75f
                    val factor = 1f + params.highlights * weight * 0.3f
                    r *= factor
                    g *= factor
                    b *= factor
                }
            }
            
            // シャドウ
            if (params.shadows != 0f) {
                val luminance = 0.299f * r + 0.587f * g + 0.114f * b
                if (luminance < 75f) {
                    val weight = (75f - luminance) / 75f
                    val factor = 1f + params.shadows * weight * 0.5f
                    r *= factor
                    g *= factor
                    b *= factor
                }
            }
            
            // ホワイト
            if (params.whites != 0f) {
                val luminance = 0.299f * r + 0.587f * g + 0.114f * b
                if (luminance > 220f) {
                    val adjustment = params.whites * 30f
                    r += adjustment
                    g += adjustment
                    b += adjustment
                }
            }
            
            // ブラック
            if (params.blacks != 0f) {
                val luminance = 0.299f * r + 0.587f * g + 0.114f * b
                if (luminance < 35f) {
                    val adjustment = params.blacks * 30f
                    r += adjustment
                    g += adjustment
                    b += adjustment
                }
            }
            
            // クラリティ（ローカルコントラスト強調の簡易版）
            if (params.clarity != 0f) {
                val mid = 128f
                val factor = 1f + params.clarity * 0.3f
                r = mid + (r - mid) * factor
                g = mid + (g - mid) * factor
                b = mid + (b - mid) * factor
            }
            
            // デヘイズ
            if (params.dehaze != 0f) {
                val minVal = minOf(r, g, b)
                val dehazeFactor = params.dehaze * 0.3f
                r -= minVal * dehazeFactor
                g -= minVal * dehazeFactor
                b -= minVal * dehazeFactor
                // コントラストも少し上げる
                r = 128f + (r - 128f) * (1f + dehazeFactor * 0.2f)
                g = 128f + (g - 128f) * (1f + dehazeFactor * 0.2f)
                b = 128f + (b - 128f) * (1f + dehazeFactor * 0.2f)
            }
            
            // HSL個別調整
            if (params.hslAdjustments.isNotEmpty()) {
                val hsl = rgbToHsl(r, g, b)
                
                for ((range, adjustment) in params.hslAdjustments) {
                    val hue = hsl[0]
                    val weight = calculateHueWeight(hue, range)
                    
                    if (weight > 0f) {
                        hsl[0] += adjustment.hueShift * weight
                        hsl[1] *= 1f + adjustment.saturation * weight
                        hsl[2] *= 1f + adjustment.luminance * weight
                    }
                }
                
                hsl[0] = (hsl[0] % 360f + 360f) % 360f
                hsl[1] = hsl[1].coerceIn(0f, 1f)
                hsl[2] = hsl[2].coerceIn(0f, 1f)
                
                val rgb = hslToRgb(hsl[0], hsl[1], hsl[2])
                r = rgb[0]
                g = rgb[1]
                b = rgb[2]
            }
            
            // クランプ
            pixels[i] = Color.argb(
                a,
                r.toInt().coerceIn(0, 255),
                g.toInt().coerceIn(0, 255),
                b.toInt().coerceIn(0, 255)
            )
        }
        
        result.setPixels(pixels, 0, width, 0, 0, width, height)
        
        // シャープネス（簡易版）
        if (params.sharpness > 0f) {
            applySharpness(result, params.sharpness)
        }
        
        result
    }
    
    private fun calculateHueWeight(hue: Float, range: HueRange): Float {
        val normalizedHue = (hue % 360f + 360f) % 360f
        
        return if (range.minHue > range.maxHue) {
            // 赤のように0度をまたぐ場合
            if (normalizedHue >= range.minHue || normalizedHue <= range.maxHue) {
                val distance = minOf(
                    if (normalizedHue >= range.minHue) normalizedHue - range.minHue else 360f - range.minHue + normalizedHue,
                    if (normalizedHue <= range.maxHue) range.maxHue - normalizedHue else normalizedHue - range.maxHue
                )
                (1f - distance / 30f).coerceIn(0f, 1f)
            } else 0f
        } else {
            if (normalizedHue in range.minHue..range.maxHue) {
                val center = (range.minHue + range.maxHue) / 2
                val halfWidth = (range.maxHue - range.minHue) / 2
                (1f - Math.abs(normalizedHue - center) / halfWidth).coerceIn(0f, 1f)
            } else 0f
        }
    }
    
    private fun rgbToHsl(r: Float, g: Float, b: Float): FloatArray {
        val rNorm = r / 255f
        val gNorm = g / 255f
        val bNorm = b / 255f
        
        val max = maxOf(rNorm, gNorm, bNorm)
        val min = minOf(rNorm, gNorm, bNorm)
        val delta = max - min
        
        var h = 0f
        val l = (max + min) / 2f
        val s = if (delta == 0f) 0f else delta / (1f - Math.abs(2f * l - 1f))
        
        if (delta != 0f) {
            h = when (max) {
                rNorm -> 60f * (((gNorm - bNorm) / delta) % 6f)
                gNorm -> 60f * ((bNorm - rNorm) / delta + 2f)
                else -> 60f * ((rNorm - gNorm) / delta + 4f)
            }
        }
        
        if (h < 0) h += 360f
        
        return floatArrayOf(h, s, l)
    }
    
    private fun hslToRgb(h: Float, s: Float, l: Float): FloatArray {
        val c = (1f - Math.abs(2f * l - 1f)) * s
        val x = c * (1f - Math.abs((h / 60f) % 2f - 1f))
        val m = l - c / 2f
        
        val (r1, g1, b1) = when {
            h < 60f -> Triple(c, x, 0f)
            h < 120f -> Triple(x, c, 0f)
            h < 180f -> Triple(0f, c, x)
            h < 240f -> Triple(0f, x, c)
            h < 300f -> Triple(x, 0f, c)
            else -> Triple(c, 0f, x)
        }
        
        return floatArrayOf(
            (r1 + m) * 255f,
            (g1 + m) * 255f,
            (b1 + m) * 255f
        )
    }
    
    private fun applySharpness(bitmap: Bitmap, amount: Float) {
        // 簡易シャープネス（アンシャープマスクの簡易版）
        val width = bitmap.width
        val height = bitmap.height
        val pixels = IntArray(width * height)
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
        
        val result = IntArray(width * height)
        val strength = amount * 0.5f
        
        for (y in 1 until height - 1) {
            for (x in 1 until width - 1) {
                val idx = y * width + x
                
                val center = pixels[idx]
                val top = pixels[(y - 1) * width + x]
                val bottom = pixels[(y + 1) * width + x]
                val left = pixels[y * width + (x - 1)]
                val right = pixels[y * width + (x + 1)]
                
                val avgR = (Color.red(top) + Color.red(bottom) + Color.red(left) + Color.red(right)) / 4f
                val avgG = (Color.green(top) + Color.green(bottom) + Color.green(left) + Color.green(right)) / 4f
                val avgB = (Color.blue(top) + Color.blue(bottom) + Color.blue(left) + Color.blue(right)) / 4f
                
                val r = (Color.red(center) + (Color.red(center) - avgR) * strength).toInt().coerceIn(0, 255)
                val g = (Color.green(center) + (Color.green(center) - avgG) * strength).toInt().coerceIn(0, 255)
                val b = (Color.blue(center) + (Color.blue(center) - avgB) * strength).toInt().coerceIn(0, 255)
                
                result[idx] = Color.argb(Color.alpha(center), r, g, b)
            }
        }
        
        // 端のピクセルをコピー
        for (x in 0 until width) {
            result[x] = pixels[x]
            result[(height - 1) * width + x] = pixels[(height - 1) * width + x]
        }
        for (y in 0 until height) {
            result[y * width] = pixels[y * width]
            result[y * width + width - 1] = pixels[y * width + width - 1]
        }
        
        bitmap.setPixels(result, 0, width, 0, 0, width, height)
    }
}

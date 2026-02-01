package com.example.photoframe.data

import androidx.annotation.DrawableRes
import androidx.compose.ui.graphics.Color

/**
 * フィルム風フィルタープリセット
 * Liitのようなヴィンテージ・フィルム感を再現
 */
data class FilterPreset(
    val id: String,
    val name: String,
    val displayName: String,
    val category: FilterCategory,
    // 色調整パラメータ
    val brightness: Float = 0f,      // -1.0 to 1.0
    val contrast: Float = 1f,        // 0.0 to 2.0
    val saturation: Float = 1f,      // 0.0 to 2.0
    val temperature: Float = 0f,     // -1.0 (cool) to 1.0 (warm)
    val tint: Float = 0f,            // -1.0 (green) to 1.0 (magenta)
    val exposure: Float = 0f,        // -1.0 to 1.0
    val highlights: Float = 0f,      // -1.0 to 1.0
    val shadows: Float = 0f,         // -1.0 to 1.0
    // フィルム質感エフェクト
    val grain: Float = 0f,           // 0.0 to 1.0
    val vignette: Float = 0f,        // 0.0 to 1.0
    val fade: Float = 0f,            // 0.0 to 1.0 (黒を持ち上げる)
    val dustAmount: Float = 0f,      // 0.0 to 1.0
    // カラーオーバーレイ
    val overlayColor: Color? = null,
    val overlayIntensity: Float = 0f
)

enum class FilterCategory(val displayName: String) {
    NONE("オリジナル"),
    FILM("フィルム"),
    VINTAGE("ヴィンテージ"),
    MODERN("モダン"),
    BW("モノクロ"),
    CINEMATIC("シネマティック"),
    INSTANT("インスタント")
}

/**
 * プリセットフィルターコレクション
 */
object FilterPresets {
    
    val ORIGINAL = FilterPreset(
        id = "original",
        name = "Original",
        displayName = "オリジナル",
        category = FilterCategory.NONE
    )
    
    // フィルム系フィルター
    val KODAK_PORTRA = FilterPreset(
        id = "kodak_portra",
        name = "Portra 400",
        displayName = "Portra 400",
        category = FilterCategory.FILM,
        temperature = 0.08f,
        saturation = 0.92f,
        contrast = 1.05f,
        highlights = -0.1f,
        shadows = 0.15f,
        grain = 0.15f,
        fade = 0.05f
    )
    
    val KODAK_GOLD = FilterPreset(
        id = "kodak_gold",
        name = "Gold 200",
        displayName = "Gold 200",
        category = FilterCategory.FILM,
        temperature = 0.15f,
        saturation = 1.1f,
        contrast = 1.1f,
        brightness = 0.05f,
        grain = 0.12f
    )
    
    val FUJI_SUPERIA = FilterPreset(
        id = "fuji_superia",
        name = "Superia",
        displayName = "Superia",
        category = FilterCategory.FILM,
        temperature = -0.05f,
        tint = 0.03f,
        saturation = 1.05f,
        contrast = 1.08f,
        grain = 0.1f
    )
    
    val FUJI_VELVIA = FilterPreset(
        id = "fuji_velvia",
        name = "Velvia",
        displayName = "Velvia",
        category = FilterCategory.FILM,
        saturation = 1.35f,
        contrast = 1.15f,
        brightness = 0.02f,
        grain = 0.08f
    )
    
    val CINESTILL_800T = FilterPreset(
        id = "cinestill_800t",
        name = "CineStill 800T",
        displayName = "800T",
        category = FilterCategory.CINEMATIC,
        temperature = -0.15f,
        tint = 0.05f,
        saturation = 0.9f,
        contrast = 1.12f,
        highlights = 0.1f,
        grain = 0.2f,
        overlayColor = Color(0xFF00AAFF),
        overlayIntensity = 0.08f
    )
    
    // ヴィンテージ系
    val VINTAGE_WARM = FilterPreset(
        id = "vintage_warm",
        name = "Warm Vintage",
        displayName = "ウォームヴィンテージ",
        category = FilterCategory.VINTAGE,
        temperature = 0.2f,
        saturation = 0.85f,
        contrast = 1.08f,
        fade = 0.12f,
        vignette = 0.25f,
        grain = 0.18f
    )
    
    val VINTAGE_COOL = FilterPreset(
        id = "vintage_cool",
        name = "Cool Vintage",
        displayName = "クールヴィンテージ",
        category = FilterCategory.VINTAGE,
        temperature = -0.12f,
        saturation = 0.8f,
        contrast = 1.05f,
        fade = 0.15f,
        vignette = 0.2f,
        grain = 0.15f
    )
    
    val FADED_MEMORY = FilterPreset(
        id = "faded_memory",
        name = "Faded Memory",
        displayName = "フェードメモリー",
        category = FilterCategory.VINTAGE,
        saturation = 0.7f,
        contrast = 0.92f,
        fade = 0.25f,
        vignette = 0.3f,
        grain = 0.2f,
        dustAmount = 0.1f
    )
    
    // モダン系
    val CLEAN = FilterPreset(
        id = "clean",
        name = "Clean",
        displayName = "クリーン",
        category = FilterCategory.MODERN,
        contrast = 1.05f,
        saturation = 1.02f,
        highlights = -0.05f,
        shadows = 0.05f
    )
    
    val MOODY = FilterPreset(
        id = "moody",
        name = "Moody",
        displayName = "ムーディー",
        category = FilterCategory.MODERN,
        contrast = 1.2f,
        saturation = 0.88f,
        shadows = -0.1f,
        highlights = -0.15f,
        vignette = 0.15f
    )
    
    // モノクロ系
    val BW_CLASSIC = FilterPreset(
        id = "bw_classic",
        name = "B&W Classic",
        displayName = "クラシックB&W",
        category = FilterCategory.BW,
        saturation = 0f,
        contrast = 1.15f,
        grain = 0.1f
    )
    
    val BW_HIGH_CONTRAST = FilterPreset(
        id = "bw_high_contrast",
        name = "B&W High",
        displayName = "ハイコントラスト",
        category = FilterCategory.BW,
        saturation = 0f,
        contrast = 1.4f,
        shadows = -0.1f,
        highlights = 0.1f
    )
    
    val BW_FILM_NOIR = FilterPreset(
        id = "bw_film_noir",
        name = "Film Noir",
        displayName = "フィルムノワール",
        category = FilterCategory.BW,
        saturation = 0f,
        contrast = 1.25f,
        vignette = 0.35f,
        grain = 0.15f
    )
    
    // インスタント系
    val POLAROID = FilterPreset(
        id = "polaroid",
        name = "Polaroid",
        displayName = "ポラロイド",
        category = FilterCategory.INSTANT,
        temperature = 0.08f,
        saturation = 0.9f,
        contrast = 1.05f,
        fade = 0.08f,
        vignette = 0.1f
    )
    
    val INSTAX = FilterPreset(
        id = "instax",
        name = "Instax",
        displayName = "チェキ風",
        category = FilterCategory.INSTANT,
        brightness = 0.05f,
        saturation = 0.95f,
        contrast = 1.02f,
        temperature = 0.03f
    )
    
    /**
     * 全フィルターリスト
     */
    val ALL_FILTERS = listOf(
        ORIGINAL,
        KODAK_PORTRA,
        KODAK_GOLD,
        FUJI_SUPERIA,
        FUJI_VELVIA,
        CINESTILL_800T,
        VINTAGE_WARM,
        VINTAGE_COOL,
        FADED_MEMORY,
        CLEAN,
        MOODY,
        BW_CLASSIC,
        BW_HIGH_CONTRAST,
        BW_FILM_NOIR,
        POLAROID,
        INSTAX
    )
    
    /**
     * カテゴリ別フィルターマップ
     */
    val BY_CATEGORY: Map<FilterCategory, List<FilterPreset>> = ALL_FILTERS.groupBy { it.category }
}

package com.example.photoframe.data

import androidx.compose.ui.graphics.Color

/**
 * フレームスタイル定義
 * インスタント・フィルム風・シンプルなフレーム各種
 */
data class FrameStyle(
    val id: String,
    val name: String,
    val displayName: String,
    val category: FrameCategory,
    val frameColor: Color = Color.White,
    val borderWidthRatio: Float = 0.03f,  // 画像幅に対する比率
    val bottomExtraRatio: Float = 0f,      // 下部の追加スペース（ポラロイド風）
    val cornerRadius: Float = 0f,          // 角丸
    val innerShadow: Boolean = false,
    val outerShadow: Boolean = true,
    val showExifInfo: Boolean = false,
    val showDateStamp: Boolean = false,
    val showShotOnWatermark: Boolean = false
)

enum class FrameCategory(val displayName: String) {
    NONE("なし"),
    SIMPLE("シンプル"),
    INSTANT("インスタント"),
    FILM("フィルム"),
    MODERN("モダン")
}

/**
 * ウォーターマーク設定
 */
data class WatermarkConfig(
    val enabled: Boolean = false,
    val type: WatermarkType = WatermarkType.SHOT_ON,
    val customText: String = "",
    val position: WatermarkPosition = WatermarkPosition.BOTTOM_RIGHT,
    val textColor: Color = Color.White,
    val fontSize: Float = 12f,
    val opacity: Float = 0.8f,
    val showMake: Boolean = true,
    val showModel: Boolean = true,
    val showLensInfo: Boolean = false,
    val showSettings: Boolean = false  // ISO, シャッタースピード, F値
)

enum class WatermarkType {
    SHOT_ON,         // "Shot on iPhone 15 Pro" 風
    EXIF_FRAME,      // EXIF情報フレーム
    DATE_STAMP,      // 日付スタンプ (フィルムカメラ風)
    CUSTOM           // カスタムテキスト
}

enum class WatermarkPosition {
    TOP_LEFT,
    TOP_CENTER,
    TOP_RIGHT,
    BOTTOM_LEFT,
    BOTTOM_CENTER,
    BOTTOM_RIGHT
}

/**
 * 日付スタンプスタイル
 */
data class DateStampStyle(
    val enabled: Boolean = false,
    val format: DateFormat = DateFormat.FILM_STYLE,
    val color: Color = Color(0xFFFF6B00),  // オレンジ色（フィルムカメラ風）
    val position: WatermarkPosition = WatermarkPosition.BOTTOM_RIGHT,
    val fontSize: Float = 14f
)

enum class DateFormat(val pattern: String, val displayName: String) {
    FILM_STYLE("'yy MM dd", "フィルム風 ('24 01 15)"),
    STANDARD("yyyy/MM/dd", "標準 (2024/01/15)"),
    US_STYLE("MM/dd/yyyy", "US式 (01/15/2024)"),
    EU_STYLE("dd.MM.yyyy", "EU式 (15.01.2024)"),
    FULL("yyyy年M月d日", "日本式 (2024年1月15日)")
}

/**
 * フレームプリセット
 */
object FramePresets {
    
    val NONE = FrameStyle(
        id = "none",
        name = "None",
        displayName = "フレームなし",
        category = FrameCategory.NONE,
        borderWidthRatio = 0f
    )
    
    // シンプル系
    val SIMPLE_WHITE = FrameStyle(
        id = "simple_white",
        name = "Simple White",
        displayName = "シンプル白",
        category = FrameCategory.SIMPLE,
        frameColor = Color.White,
        borderWidthRatio = 0.03f
    )
    
    val SIMPLE_BLACK = FrameStyle(
        id = "simple_black",
        name = "Simple Black",
        displayName = "シンプル黒",
        category = FrameCategory.SIMPLE,
        frameColor = Color.Black,
        borderWidthRatio = 0.03f
    )
    
    val THIN_WHITE = FrameStyle(
        id = "thin_white",
        name = "Thin White",
        displayName = "細枠白",
        category = FrameCategory.SIMPLE,
        frameColor = Color.White,
        borderWidthRatio = 0.015f
    )
    
    val THICK_WHITE = FrameStyle(
        id = "thick_white",
        name = "Thick White",
        displayName = "太枠白",
        category = FrameCategory.SIMPLE,
        frameColor = Color.White,
        borderWidthRatio = 0.06f
    )
    
    // インスタント系
    val POLAROID = FrameStyle(
        id = "polaroid",
        name = "Polaroid",
        displayName = "ポラロイド",
        category = FrameCategory.INSTANT,
        frameColor = Color.White,
        borderWidthRatio = 0.04f,
        bottomExtraRatio = 0.12f,
        outerShadow = true
    )
    
    val INSTAX_MINI = FrameStyle(
        id = "instax_mini",
        name = "Instax Mini",
        displayName = "チェキ風",
        category = FrameCategory.INSTANT,
        frameColor = Color.White,
        borderWidthRatio = 0.035f,
        bottomExtraRatio = 0.08f,
        cornerRadius = 4f,
        outerShadow = true
    )
    
    val INSTAX_SQUARE = FrameStyle(
        id = "instax_square",
        name = "Instax Square",
        displayName = "チェキスクエア",
        category = FrameCategory.INSTANT,
        frameColor = Color.White,
        borderWidthRatio = 0.04f,
        bottomExtraRatio = 0.06f,
        cornerRadius = 4f,
        outerShadow = true
    )
    
    // フィルム系
    val FILM_STRIP = FrameStyle(
        id = "film_strip",
        name = "Film Strip",
        displayName = "フィルムストリップ",
        category = FrameCategory.FILM,
        frameColor = Color.Black,
        borderWidthRatio = 0.025f,
        showExifInfo = true
    )
    
    val SLIDE_MOUNT = FrameStyle(
        id = "slide_mount",
        name = "Slide Mount",
        displayName = "スライドマウント",
        category = FrameCategory.FILM,
        frameColor = Color.White,
        borderWidthRatio = 0.05f,
        cornerRadius = 2f
    )
    
    // モダン系
    val ROUNDED = FrameStyle(
        id = "rounded",
        name = "Rounded",
        displayName = "角丸",
        category = FrameCategory.MODERN,
        frameColor = Color.White,
        borderWidthRatio = 0.03f,
        cornerRadius = 16f
    )
    
    val SHADOW_BOX = FrameStyle(
        id = "shadow_box",
        name = "Shadow Box",
        displayName = "シャドウボックス",
        category = FrameCategory.MODERN,
        frameColor = Color.White,
        borderWidthRatio = 0.05f,
        innerShadow = true,
        outerShadow = true
    )
    
    /**
     * 全フレームリスト
     */
    val ALL_FRAMES = listOf(
        NONE,
        SIMPLE_WHITE,
        SIMPLE_BLACK,
        THIN_WHITE,
        THICK_WHITE,
        POLAROID,
        INSTAX_MINI,
        INSTAX_SQUARE,
        FILM_STRIP,
        SLIDE_MOUNT,
        ROUNDED,
        SHADOW_BOX
    )
    
    /**
     * カテゴリ別フレームマップ
     */
    val BY_CATEGORY: Map<FrameCategory, List<FrameStyle>> = ALL_FRAMES.groupBy { it.category }
}

package com.example.photoframe.ui.screens

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.animation.*
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.example.photoframe.data.*
import com.example.photoframe.processing.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 編集画面 - Nothing風ミニマルUI
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditScreen(
    imageUri: String,
    onSave: (Bitmap) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    
    var originalBitmap by remember { mutableStateOf<Bitmap?>(null) }
    var processedBitmap by remember { mutableStateOf<Bitmap?>(null) }
    var isProcessing by remember { mutableStateOf(false) }
    
    // 編集状態
    var selectedFilter by remember { mutableStateOf(FilterPresets.ORIGINAL) }
    var selectedFrame by remember { mutableStateOf(FramePresets.NONE) }
    var editParams by remember { mutableStateOf(EditEngine.EditParams()) }
    var watermarkConfig by remember { mutableStateOf(WatermarkConfig()) }
    var dateStampStyle by remember { mutableStateOf(DateStampStyle()) }
    
    // UI状態
    var activeTab by remember { mutableStateOf(EditTab.FILTERS) }
    var showAdjustments by remember { mutableStateOf(false) }
    
    // 画像読み込み
    LaunchedEffect(imageUri) {
        withContext(Dispatchers.IO) {
            try {
                val uri = Uri.parse(imageUri)
                context.contentResolver.openInputStream(uri)?.use { input ->
                    originalBitmap = BitmapFactory.decodeStream(input)
                    processedBitmap = originalBitmap?.copy(Bitmap.Config.ARGB_8888, true)
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }
    
    // 編集適用
    LaunchedEffect(selectedFilter, selectedFrame, editParams, watermarkConfig, dateStampStyle) {
        originalBitmap?.let { original ->
            isProcessing = true
            withContext(Dispatchers.Default) {
                var result = original.copy(Bitmap.Config.ARGB_8888, true)
                
                // フィルター適用
                if (selectedFilter.id != "original") {
                    result = FilterEngine.applyFilter(result, selectedFilter)
                }
                
                // 編集パラメータ適用
                if (editParams != EditEngine.EditParams()) {
                    result = EditEngine.applyEdits(result, editParams)
                }
                
                // フレーム適用
                if (selectedFrame.id != "none" || watermarkConfig.enabled || dateStampStyle.enabled) {
                    result = FrameEngine.applyFrame(
                        result,
                        selectedFrame,
                        exifData = null, // TODO: EXIF読み込み
                        watermarkConfig = watermarkConfig,
                        dateStampStyle = dateStampStyle
                    )
                }
                
                processedBitmap = result
            }
            isProcessing = false
        }
    }
    
    Scaffold(
        topBar = {
            EditTopBar(
                onBack = onBack,
                onSave = {
                    processedBitmap?.let { onSave(it) }
                },
                isProcessing = isProcessing
            )
        },
        containerColor = Color.Black
    ) { padding ->
        Column(
            modifier = modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            // プレビュー領域
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .background(Color.Black),
                contentAlignment = Alignment.Center
            ) {
                processedBitmap?.let { bitmap ->
                    Image(
                        bitmap = bitmap.asImageBitmap(),
                        contentDescription = null,
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(16.dp),
                        contentScale = ContentScale.Fit
                    )
                }
                
                if (isProcessing) {
                    CircularProgressIndicator(
                        color = Color.White,
                        modifier = Modifier.size(32.dp)
                    )
                }
            }
            
            // 詳細調整パネル
            AnimatedVisibility(
                visible = showAdjustments,
                enter = slideInVertically { it } + fadeIn(),
                exit = slideOutVertically { it } + fadeOut()
            ) {
                AdjustmentsPanel(
                    editParams = editParams,
                    onParamsChange = { editParams = it },
                    onClose = { showAdjustments = false }
                )
            }
            
            // タブセレクター
            EditTabBar(
                activeTab = activeTab,
                onTabChange = { activeTab = it }
            )
            
            // コンテンツエリア
            when (activeTab) {
                EditTab.FILTERS -> FilterPanel(
                    selectedFilter = selectedFilter,
                    onFilterSelected = { selectedFilter = it }
                )
                EditTab.FRAMES -> FramePanel(
                    selectedFrame = selectedFrame,
                    onFrameSelected = { selectedFrame = it }
                )
                EditTab.ADJUST -> {
                    QuickAdjustPanel(
                        editParams = editParams,
                        onParamsChange = { editParams = it },
                        onShowAll = { showAdjustments = true }
                    )
                }
                EditTab.WATERMARK -> WatermarkPanel(
                    watermarkConfig = watermarkConfig,
                    dateStampStyle = dateStampStyle,
                    onWatermarkChange = { watermarkConfig = it },
                    onDateStampChange = { dateStampStyle = it }
                )
            }
        }
    }
}

enum class EditTab(val title: String, val icon: @Composable () -> Unit) {
    FILTERS("フィルター", { Icon(Icons.Outlined.AutoAwesome, null) }),
    FRAMES("フレーム", { Icon(Icons.Outlined.Crop, null) }),
    ADJUST("調整", { Icon(Icons.Outlined.Tune, null) }),
    WATERMARK("スタンプ", { Icon(Icons.Outlined.TextFields, null) })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EditTopBar(
    onBack: () -> Unit,
    onSave: () -> Unit,
    isProcessing: Boolean
) {
    TopAppBar(
        title = { },
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(
                    Icons.Default.Close,
                    contentDescription = "戻る",
                    tint = Color.White
                )
            }
        },
        actions = {
            TextButton(
                onClick = onSave,
                enabled = !isProcessing
            ) {
                Text(
                    "保存",
                    color = if (isProcessing) Color.Gray else Color.White
                )
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = Color.Black
        )
    )
}

@Composable
private fun EditTabBar(
    activeTab: EditTab,
    onTabChange: (EditTab) -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color.Black)
            .padding(horizontal = 8.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceEvenly
    ) {
        EditTab.entries.forEach { tab ->
            val isActive = tab == activeTab
            TextButton(
                onClick = { onTabChange(tab) },
                colors = ButtonDefaults.textButtonColors(
                    contentColor = if (isActive) Color.White else Color.Gray
                )
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    tab.icon()
                    Spacer(modifier = Modifier.height(2.dp))
                    Text(
                        tab.title,
                        style = MaterialTheme.typography.labelSmall
                    )
                }
            }
        }
    }
}

@Composable
private fun FilterPanel(
    selectedFilter: FilterPreset,
    onFilterSelected: (FilterPreset) -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0xFF1A1A1A))
            .padding(16.dp)
    ) {
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            items(FilterPresets.ALL_FILTERS) { filter ->
                FilterThumbnail(
                    filter = filter,
                    isSelected = filter.id == selectedFilter.id,
                    onClick = { onFilterSelected(filter) }
                )
            }
        }
    }
}

@Composable
private fun FilterThumbnail(
    filter: FilterPreset,
    isSelected: Boolean,
    onClick: () -> Unit
) {
    Column(
        modifier = Modifier
            .width(72.dp)
            .clickable(onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(
            modifier = Modifier
                .size(60.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(if (isSelected) Color.White else Color(0xFF333333)),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = filter.name.take(2).uppercase(),
                style = MaterialTheme.typography.titleMedium,
                color = if (isSelected) Color.Black else Color.White
            )
        }
        Spacer(modifier = Modifier.height(4.dp))
        Text(
            text = filter.displayName,
            style = MaterialTheme.typography.labelSmall,
            color = if (isSelected) Color.White else Color.Gray,
            maxLines = 1
        )
    }
}

@Composable
private fun FramePanel(
    selectedFrame: FrameStyle,
    onFrameSelected: (FrameStyle) -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0xFF1A1A1A))
            .padding(16.dp)
    ) {
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            items(FramePresets.ALL_FRAMES) { frame ->
                FrameThumbnail(
                    frame = frame,
                    isSelected = frame.id == selectedFrame.id,
                    onClick = { onFrameSelected(frame) }
                )
            }
        }
    }
}

@Composable
private fun FrameThumbnail(
    frame: FrameStyle,
    isSelected: Boolean,
    onClick: () -> Unit
) {
    Column(
        modifier = Modifier
            .width(72.dp)
            .clickable(onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(
            modifier = Modifier
                .size(60.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(Color(0xFF333333)),
            contentAlignment = Alignment.Center
        ) {
            // フレームプレビュー
            Box(
                modifier = Modifier
                    .size(if (frame.id == "none") 50.dp else 44.dp)
                    .background(
                        if (frame.id == "none") Color(0xFF555555)
                        else Color(frame.frameColor.red, frame.frameColor.green, frame.frameColor.blue)
                    )
                    .padding(if (frame.id == "none") 0.dp else 4.dp)
            ) {
                if (frame.id != "none") {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .background(Color(0xFF555555))
                    )
                }
            }
            
            if (isSelected) {
                Box(
                    modifier = Modifier
                        .size(60.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(Color.White.copy(alpha = 0.2f)),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        Icons.Default.Check,
                        contentDescription = null,
                        tint = Color.White
                    )
                }
            }
        }
        Spacer(modifier = Modifier.height(4.dp))
        Text(
            text = frame.displayName,
            style = MaterialTheme.typography.labelSmall,
            color = if (isSelected) Color.White else Color.Gray,
            maxLines = 1
        )
    }
}

@Composable
private fun QuickAdjustPanel(
    editParams: EditEngine.EditParams,
    onParamsChange: (EditEngine.EditParams) -> Unit,
    onShowAll: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0xFF1A1A1A))
            .padding(16.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                "クイック調整",
                style = MaterialTheme.typography.titleSmall,
                color = Color.White
            )
            TextButton(onClick = onShowAll) {
                Text("すべて表示", color = Color.Gray)
            }
        }
        
        Spacer(modifier = Modifier.height(12.dp))
        
        // 明るさスライダー
        AdjustSlider(
            label = "明るさ",
            value = editParams.brightness,
            onValueChange = { onParamsChange(editParams.copy(brightness = it)) },
            valueRange = -1f..1f
        )
        
        // コントラストスライダー
        AdjustSlider(
            label = "コントラスト",
            value = editParams.contrast - 1f,
            onValueChange = { onParamsChange(editParams.copy(contrast = it + 1f)) },
            valueRange = -1f..1f
        )
        
        // 彩度スライダー
        AdjustSlider(
            label = "彩度",
            value = editParams.saturation - 1f,
            onValueChange = { onParamsChange(editParams.copy(saturation = it + 1f)) },
            valueRange = -1f..1f
        )
    }
}

@Composable
private fun AdjustSlider(
    label: String,
    value: Float,
    onValueChange: (Float) -> Unit,
    valueRange: ClosedFloatingPointRange<Float>
) {
    Column(modifier = Modifier.padding(vertical = 4.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(
                label,
                style = MaterialTheme.typography.bodySmall,
                color = Color.Gray
            )
            Text(
                "%+.0f".format(value * 100),
                style = MaterialTheme.typography.bodySmall,
                color = Color.White
            )
        }
        Slider(
            value = value,
            onValueChange = onValueChange,
            valueRange = valueRange,
            colors = SliderDefaults.colors(
                thumbColor = Color.White,
                activeTrackColor = Color.White,
                inactiveTrackColor = Color.Gray
            )
        )
    }
}

@Composable
private fun AdjustmentsPanel(
    editParams: EditEngine.EditParams,
    onParamsChange: (EditEngine.EditParams) -> Unit,
    onClose: () -> Unit
) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .fillMaxHeight(0.5f),
        color = Color(0xFF1A1A1A),
        shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(16.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    "詳細調整",
                    style = MaterialTheme.typography.titleMedium,
                    color = Color.White
                )
                IconButton(onClick = onClose) {
                    Icon(Icons.Default.Close, null, tint = Color.White)
                }
            }
            
            Spacer(modifier = Modifier.height(16.dp))
            
            androidx.compose.foundation.lazy.LazyColumn {
                item {
                    Text("ライト", color = Color.Gray, style = MaterialTheme.typography.labelMedium)
                    AdjustSlider("露出", editParams.exposure, { onParamsChange(editParams.copy(exposure = it)) }, -2f..2f)
                    AdjustSlider("明るさ", editParams.brightness, { onParamsChange(editParams.copy(brightness = it)) }, -1f..1f)
                    AdjustSlider("コントラスト", editParams.contrast - 1f, { onParamsChange(editParams.copy(contrast = it + 1f)) }, -1f..1f)
                    AdjustSlider("ハイライト", editParams.highlights, { onParamsChange(editParams.copy(highlights = it)) }, -1f..1f)
                    AdjustSlider("シャドウ", editParams.shadows, { onParamsChange(editParams.copy(shadows = it)) }, -1f..1f)
                }
                
                item {
                    Spacer(modifier = Modifier.height(16.dp))
                    Text("カラー", color = Color.Gray, style = MaterialTheme.typography.labelMedium)
                    AdjustSlider("彩度", editParams.saturation - 1f, { onParamsChange(editParams.copy(saturation = it + 1f)) }, -1f..1f)
                    AdjustSlider("バイブランス", editParams.vibrance, { onParamsChange(editParams.copy(vibrance = it)) }, -1f..1f)
                    AdjustSlider("色温度", editParams.temperature, { onParamsChange(editParams.copy(temperature = it)) }, -1f..1f)
                    AdjustSlider("ティント", editParams.tint, { onParamsChange(editParams.copy(tint = it)) }, -1f..1f)
                }
                
                item {
                    Spacer(modifier = Modifier.height(16.dp))
                    Text("エフェクト", color = Color.Gray, style = MaterialTheme.typography.labelMedium)
                    AdjustSlider("クラリティ", editParams.clarity, { onParamsChange(editParams.copy(clarity = it)) }, -1f..1f)
                    AdjustSlider("デヘイズ", editParams.dehaze, { onParamsChange(editParams.copy(dehaze = it)) }, -1f..1f)
                    AdjustSlider("シャープネス", editParams.sharpness, { onParamsChange(editParams.copy(sharpness = it)) }, 0f..1f)
                }
            }
        }
    }
}

@Composable
private fun WatermarkPanel(
    watermarkConfig: WatermarkConfig,
    dateStampStyle: DateStampStyle,
    onWatermarkChange: (WatermarkConfig) -> Unit,
    onDateStampChange: (DateStampStyle) -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0xFF1A1A1A))
            .padding(16.dp)
    ) {
        // Shot on ウォーターマーク
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(
                    "Shot on ウォーターマーク",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color.White
                )
                Text(
                    "撮影機器情報を表示",
                    style = MaterialTheme.typography.bodySmall,
                    color = Color.Gray
                )
            }
            Switch(
                checked = watermarkConfig.enabled && watermarkConfig.type == WatermarkType.SHOT_ON,
                onCheckedChange = {
                    onWatermarkChange(watermarkConfig.copy(
                        enabled = it,
                        type = WatermarkType.SHOT_ON
                    ))
                },
                colors = SwitchDefaults.colors(
                    checkedThumbColor = Color.White,
                    checkedTrackColor = Color.Gray
                )
            )
        }
        
        Spacer(modifier = Modifier.height(16.dp))
        
        // 日付スタンプ
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(
                    "日付スタンプ",
                    style = MaterialTheme.typography.bodyMedium,
                    color = Color.White
                )
                Text(
                    "フィルムカメラ風の日付表示",
                    style = MaterialTheme.typography.bodySmall,
                    color = Color.Gray
                )
            }
            Switch(
                checked = dateStampStyle.enabled,
                onCheckedChange = {
                    onDateStampChange(dateStampStyle.copy(enabled = it))
                },
                colors = SwitchDefaults.colors(
                    checkedThumbColor = Color.White,
                    checkedTrackColor = Color.Gray
                )
            )
        }
        
        // 日付フォーマット選択
        if (dateStampStyle.enabled) {
            Spacer(modifier = Modifier.height(12.dp))
            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                items(DateFormat.entries.toList()) { format ->
                    FilterChip(
                        selected = dateStampStyle.format == format,
                        onClick = { onDateStampChange(dateStampStyle.copy(format = format)) },
                        label = { Text(format.displayName, style = MaterialTheme.typography.labelSmall) },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = Color.White,
                            selectedLabelColor = Color.Black
                        )
                    )
                }
            }
        }
    }
}

package com.example.photoframe.ui.screens

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.outlined.ArrowBack
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.example.photoframe.data.FramePresets
import com.example.photoframe.data.FrameStyle
import com.example.photoframe.processing.FrameEngine
import com.example.photoframe.utils.ImageUtils
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Batch frame application screen.
 * Applies a single frame style to multiple selected images and saves them all.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BatchEditScreen(
    imageUris: List<String>,
    onBack: () -> Unit,
    onComplete: (Int) -> Unit
) {
    val context = LocalContext.current
    val scope   = rememberCoroutineScope()

    // Frame settings state
    var selectedFrameColorName by remember { mutableStateOf("light_gray") }
    var borderWidthRatio by remember { mutableFloatStateOf(0.04f) }
    var bottomExtraRatio by remember { mutableFloatStateOf(0.12f) }
    var showExifInFrame by remember { mutableStateOf(true) }

    // Processing state
    var isProcessing by remember { mutableStateOf(false) }
    var progress by remember { mutableIntStateOf(0) }
    var isDone by remember { mutableStateOf(false) }
    var savedCount by remember { mutableIntStateOf(0) }

    val frameColorOptions = listOf(
        Triple("white",      "ホワイト",     Color.White),
        Triple("light_gray", "ライトグレー", Color(0xFFF0F0F0)),
        Triple("black",      "ブラック",     Color(0xFF1A1A1A)),
    )

    fun buildFrameStyle(): FrameStyle {
        val color = frameColorOptions.first { it.first == selectedFrameColorName }.third
        return FramePresets.POLAROID.copy(
            frameColor       = color,
            borderWidthRatio = borderWidthRatio,
            bottomExtraRatio = if (showExifInFrame) bottomExtraRatio else 0f,
            showExifInfo     = showExifInFrame,
        )
    }

    fun startBatchProcessing() {
        scope.launch {
            isProcessing = true
            progress     = 0

            val bitmaps = mutableListOf<android.graphics.Bitmap>()

            imageUris.forEachIndexed { index, uriStr ->
                val uri = Uri.parse(uriStr)
                val exifData = ImageUtils.readExifData(context, uri)

                val bitmap = withContext(Dispatchers.IO) {
                    context.contentResolver.openInputStream(uri)?.use { stream ->
                        BitmapFactory.decodeStream(stream)
                    }
                } ?: run {
                    progress = index + 1
                    return@forEachIndexed
                }

                val framed = FrameEngine.applyFrame(
                    bitmap    = bitmap,
                    frameStyle = buildFrameStyle(),
                    exifData  = exifData,
                )
                bitmap.recycle()
                bitmaps.add(framed)
                progress = index + 1
            }

            savedCount = ImageUtils.saveMultipleToGallery(context, bitmaps)
            bitmaps.forEach { it.recycle() }

            isProcessing = false
            isDone       = true
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack, enabled = !isProcessing) {
                        Icon(Icons.Outlined.ArrowBack, "戻る")
                    }
                },
                title = { Text("バッチフレーム追加") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background
                )
            )
        }
    ) { padding ->

        if (isDone) {
            // Completion screen
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentAlignment = Alignment.Center
            ) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(20.dp)
                ) {
                    Icon(
                        Icons.Outlined.CheckCircle,
                        contentDescription = null,
                        modifier = Modifier.size(72.dp),
                        tint = MaterialTheme.colorScheme.primary
                    )
                    Text(
                        "${savedCount}枚の写真をギャラリーに保存しました",
                        style = MaterialTheme.typography.titleMedium
                    )
                    Button(onClick = { onComplete(savedCount) }) {
                        Text("ギャラリーに戻る")
                    }
                }
            }
            return@Scaffold
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp)
        ) {

            // Image count info
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = MaterialTheme.colorScheme.secondaryContainer
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Icon(
                        Icons.Filled.AutoAwesome,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSecondaryContainer
                    )
                    Column {
                        Text(
                            "${imageUris.size}枚の写真を一括処理",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.onSecondaryContainer
                        )
                        Text(
                            "同じフレーム設定を全ての写真に適用します",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSecondaryContainer.copy(alpha = 0.7f)
                        )
                    }
                }
            }

            // Frame Color
            SectionHeader("フレームカラー")
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                frameColorOptions.forEach { (key, label, color) ->
                    val isSelected = key == selectedFrameColorName
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                        modifier = Modifier.clickable { selectedFrameColorName = key }
                    ) {
                        Box(
                            modifier = Modifier
                                .size(44.dp)
                                .clip(CircleShape)
                                .background(color)
                                .then(
                                    if (isSelected) Modifier.border(3.dp, MaterialTheme.colorScheme.primary, CircleShape)
                                    else Modifier.border(1.dp, MaterialTheme.colorScheme.outline, CircleShape)
                                )
                        )
                        Text(
                            label,
                            style = MaterialTheme.typography.labelSmall,
                            color = if (isSelected) MaterialTheme.colorScheme.primary
                                    else MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }

            // Border Width
            SectionHeader("フレームの太さ")
            SliderWithLabel(
                value = borderWidthRatio,
                onValueChange = { borderWidthRatio = it },
                valueRange = 0.01f..0.1f,
                label = "%.0f%%".format(borderWidthRatio * 100)
            )

            // EXIF info toggle
            SectionHeader("EXIFフレーム")
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        "下部にカメラ情報を表示",
                        style = MaterialTheme.typography.bodyMedium
                    )
                    Text(
                        "「Shot on」＋ レンズ・シャッタースピード・ISO",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Switch(
                    checked = showExifInFrame,
                    onCheckedChange = { showExifInFrame = it }
                )
            }

            if (showExifInFrame) {
                SliderWithLabel(
                    value = bottomExtraRatio,
                    onValueChange = { bottomExtraRatio = it },
                    valueRange = 0.05f..0.25f,
                    label = "下部スペース %.0f%%".format(bottomExtraRatio * 100)
                )
            }

            Spacer(Modifier.height(8.dp))

            // Processing progress
            if (isProcessing) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        "処理中… $progress / ${imageUris.size}",
                        style = MaterialTheme.typography.bodyMedium
                    )
                    LinearProgressIndicator(
                        progress = { progress.toFloat() / imageUris.size.coerceAtLeast(1) },
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }

            // Action button
            Button(
                onClick = { startBatchProcessing() },
                modifier = Modifier.fillMaxWidth(),
                enabled = !isProcessing
            ) {
                if (isProcessing) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary
                    )
                    Spacer(Modifier.width(8.dp))
                    Text("処理中...")
                } else {
                    Icon(Icons.Filled.AutoAwesome, null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("${imageUris.size}枚にフレームを追加してギャラリーに保存")
                }
            }
        }
    }
}

@Composable
private fun SectionHeader(title: String) {
    Text(
        title,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        fontWeight = FontWeight.SemiBold
    )
}

@Composable
private fun SliderWithLabel(
    value: Float,
    onValueChange: (Float) -> Unit,
    valueRange: ClosedFloatingPointRange<Float>,
    label: String
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Slider(
            value = value,
            onValueChange = onValueChange,
            valueRange = valueRange,
            modifier = Modifier.weight(1f)
        )
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(56.dp)
        )
    }
}

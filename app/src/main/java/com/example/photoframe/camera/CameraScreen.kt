package com.example.photoframe.camera

import android.view.ViewGroup
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
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
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import com.example.photoframe.data.FilterPreset
import com.example.photoframe.data.FilterPresets
import kotlinx.coroutines.launch

/**
 * カメラ画面コンポーザブル
 * Nothing風のミニマルなカメラUI
 */
@Composable
fun CameraScreen(
    cameraManager: CameraManager,
    onPhotoTaken: (String) -> Unit,
    onNavigateToGallery: () -> Unit,
    onNavigateToEdit: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    
    val cameraState by cameraManager.cameraState.collectAsState()
    val lensFacing by cameraManager.currentLensFacing.collectAsState()
    val flashMode by cameraManager.flashMode.collectAsState()
    val zoomRatio by cameraManager.zoomRatio.collectAsState()
    
    var selectedFilter by remember { mutableStateOf(FilterPresets.ORIGINAL) }
    var showFilterSelector by remember { mutableStateOf(false) }
    var previewView by remember { mutableStateOf<PreviewView?>(null) }
    
    // カメラ起動
    LaunchedEffect(Unit) {
        previewView?.let { pv ->
            cameraManager.startCamera(lifecycleOwner, pv)
        }
    }
    
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color.Black)
    ) {
        // カメラプレビュー
        AndroidView(
            factory = { ctx ->
                PreviewView(ctx).apply {
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                    scaleType = PreviewView.ScaleType.FILL_CENTER
                    implementationMode = PreviewView.ImplementationMode.PERFORMANCE
                    previewView = this
                    cameraManager.startCamera(lifecycleOwner, this)
                }
            },
            modifier = Modifier
                .fillMaxSize()
                .pointerInput(Unit) {
                    detectTapGestures { offset ->
                        previewView?.let { pv ->
                            cameraManager.focusOnPoint(offset.x, offset.y, pv)
                        }
                    }
                }
                .pointerInput(Unit) {
                    detectTransformGestures { _, _, zoom, _ ->
                        cameraManager.setZoom(zoomRatio * zoom)
                    }
                }
        )
        
        // トップバー
        CameraTopBar(
            flashMode = flashMode,
            onFlashClick = { cameraManager.toggleFlash() },
            modifier = Modifier
                .align(Alignment.TopCenter)
                .statusBarsPadding()
        )
        
        // ズーム表示
        if (zoomRatio > 1.1f) {
            ZoomIndicator(
                zoomRatio = zoomRatio,
                modifier = Modifier.align(Alignment.Center)
            )
        }
        
        // フィルターセレクター
        if (showFilterSelector) {
            FilterSelector(
                selectedFilter = selectedFilter,
                onFilterSelected = { filter ->
                    selectedFilter = filter
                    cameraManager.setFilter(filter)
                },
                onDismiss = { showFilterSelector = false },
                modifier = Modifier.align(Alignment.BottomCenter)
            )
        }
        
        // ボトムコントロール
        CameraBottomControls(
            cameraState = cameraState,
            lensFacing = lensFacing,
            onCaptureClick = {
                cameraManager.takePhoto(
                    onSuccess = { uri ->
                        onPhotoTaken(uri)
                        onNavigateToEdit(uri)
                    },
                    onError = { /* Handle error */ }
                )
            },
            onSwitchCameraClick = {
                previewView?.let { pv ->
                    cameraManager.switchCamera(lifecycleOwner, pv)
                }
            },
            onGalleryClick = onNavigateToGallery,
            onFilterClick = { showFilterSelector = !showFilterSelector },
            showFilterSelector = showFilterSelector,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
        )
    }
}

@Composable
private fun CameraTopBar(
    flashMode: Int,
    onFlashClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(16.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        // フラッシュボタン
        IconButton(
            onClick = onFlashClick,
            modifier = Modifier
                .size(44.dp)
                .background(Color.Black.copy(alpha = 0.3f), CircleShape)
        ) {
            Icon(
                imageVector = when (flashMode) {
                    ImageCapture.FLASH_MODE_ON -> Icons.Filled.FlashOn
                    ImageCapture.FLASH_MODE_AUTO -> Icons.Filled.FlashAuto
                    else -> Icons.Filled.FlashOff
                },
                contentDescription = "Flash",
                tint = Color.White
            )
        }
        
        Spacer(modifier = Modifier.weight(1f))
        
        // 設定ボタン（将来拡張用）
        IconButton(
            onClick = { /* TODO: Settings */ },
            modifier = Modifier
                .size(44.dp)
                .background(Color.Black.copy(alpha = 0.3f), CircleShape)
        ) {
            Icon(
                imageVector = Icons.Outlined.Settings,
                contentDescription = "Settings",
                tint = Color.White
            )
        }
    }
}

@Composable
private fun CameraBottomControls(
    cameraState: CameraState,
    lensFacing: Int,
    onCaptureClick: () -> Unit,
    onSwitchCameraClick: () -> Unit,
    onGalleryClick: () -> Unit,
    onFilterClick: () -> Unit,
    showFilterSelector: Boolean,
    modifier: Modifier = Modifier
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        // フィルターボタン
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 24.dp),
            horizontalArrangement = Arrangement.Center
        ) {
            FilledTonalButton(
                onClick = onFilterClick,
                colors = ButtonDefaults.filledTonalButtonColors(
                    containerColor = if (showFilterSelector) Color.White else Color.Black.copy(alpha = 0.5f),
                    contentColor = if (showFilterSelector) Color.Black else Color.White
                ),
                shape = RoundedCornerShape(20.dp)
            ) {
                Icon(
                    imageVector = Icons.Outlined.AutoAwesome,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text("フィルター")
            }
        }
        
        // メインコントロール
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically
        ) {
            // ギャラリーボタン
            IconButton(
                onClick = onGalleryClick,
                modifier = Modifier
                    .size(50.dp)
                    .background(Color.Black.copy(alpha = 0.3f), CircleShape)
            ) {
                Icon(
                    imageVector = Icons.Outlined.PhotoLibrary,
                    contentDescription = "Gallery",
                    tint = Color.White,
                    modifier = Modifier.size(26.dp)
                )
            }
            
            // シャッターボタン
            ShutterButton(
                isCapturing = cameraState is CameraState.Capturing,
                onClick = onCaptureClick,
                modifier = Modifier.size(80.dp)
            )
            
            // カメラ切り替えボタン
            IconButton(
                onClick = onSwitchCameraClick,
                modifier = Modifier
                    .size(50.dp)
                    .background(Color.Black.copy(alpha = 0.3f), CircleShape)
            ) {
                Icon(
                    imageVector = if (lensFacing == CameraSelector.LENS_FACING_BACK) 
                        Icons.Outlined.CameraFront else Icons.Outlined.CameraRear,
                    contentDescription = "Switch Camera",
                    tint = Color.White,
                    modifier = Modifier.size(26.dp)
                )
            }
        }
    }
}

@Composable
private fun ShutterButton(
    isCapturing: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Box(
        modifier = modifier
            .clip(CircleShape)
            .background(Color.White.copy(alpha = 0.2f))
            .border(3.dp, Color.White, CircleShape)
            .clickable(enabled = !isCapturing, onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        Box(
            modifier = Modifier
                .size(if (isCapturing) 50.dp else 64.dp)
                .clip(CircleShape)
                .background(Color.White)
        )
    }
}

@Composable
private fun ZoomIndicator(
    zoomRatio: Float,
    modifier: Modifier = Modifier
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(16.dp),
        color = Color.Black.copy(alpha = 0.6f)
    ) {
        Text(
            text = "%.1fx".format(zoomRatio),
            color = Color.White,
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp)
        )
    }
}

@Composable
private fun FilterSelector(
    selectedFilter: FilterPreset,
    onFilterSelected: (FilterPreset) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier
) {
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .padding(bottom = 160.dp),
        shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
        color = Color.Black.copy(alpha = 0.85f)
    ) {
        Column(
            modifier = Modifier.padding(16.dp)
        ) {
            // ヘッダー
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "フィルター",
                    style = MaterialTheme.typography.titleMedium,
                    color = Color.White
                )
                IconButton(onClick = onDismiss) {
                    Icon(
                        imageVector = Icons.Default.Close,
                        contentDescription = "Close",
                        tint = Color.White
                    )
                }
            }
            
            // フィルターリスト
            androidx.compose.foundation.lazy.LazyRow(
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                items(FilterPresets.ALL_FILTERS.size) { index ->
                    val filter = FilterPresets.ALL_FILTERS[index]
                    FilterChip(
                        filter = filter,
                        isSelected = filter.id == selectedFilter.id,
                        onClick = { onFilterSelected(filter) }
                    )
                }
            }
        }
    }
}

@Composable
private fun FilterChip(
    filter: FilterPreset,
    isSelected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Column(
        modifier = modifier
            .width(70.dp)
            .clickable(onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(
            modifier = Modifier
                .size(56.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(if (isSelected) Color.White else Color.Gray.copy(alpha = 0.3f))
                .border(
                    width = if (isSelected) 2.dp else 0.dp,
                    color = Color.White,
                    shape = RoundedCornerShape(12.dp)
                ),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = filter.name.take(2).uppercase(),
                style = MaterialTheme.typography.labelMedium,
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

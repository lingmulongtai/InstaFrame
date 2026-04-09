package com.example.photoframe.ui.screens

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import coil.request.ImageRequest

/**
 * Gallery screen with multi-select support for batch frame processing.
 * Long-press any image to enter selection mode.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun GalleryScreen(
    onImageSelected: (String) -> Unit,
    onNavigateToCamera: () -> Unit,
    onNavigateToBatchEdit: (List<String>) -> Unit = {},
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    var selectedImages by remember { mutableStateOf<List<Uri>>(emptyList()) }
    var selectionMode by remember { mutableStateOf(false) }
    var selectedUris by remember { mutableStateOf<Set<Uri>>(emptySet()) }

    // Exit selection mode helper
    fun exitSelectionMode() {
        selectionMode = false
        selectedUris = emptySet()
    }

    val multipleImageLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenMultipleDocuments()
    ) { uris ->
        uris.forEach { uri ->
            context.contentResolver.takePersistableUriPermission(
                uri,
                android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
            )
        }
        selectedImages = selectedImages + uris
        uris.firstOrNull()?.let { onImageSelected(it.toString()) }
    }

    val singleImageLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument()
    ) { uri ->
        uri?.let {
            context.contentResolver.takePersistableUriPermission(
                it,
                android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
            )
            selectedImages = selectedImages + it
            onImageSelected(it.toString())
        }
    }

    Scaffold(
        topBar = {
            if (selectionMode) {
                // Selection mode top bar
                TopAppBar(
                    navigationIcon = {
                        IconButton(onClick = { exitSelectionMode() }) {
                            Icon(Icons.Filled.Close, contentDescription = "キャンセル")
                        }
                    },
                    title = {
                        Text(
                            "${selectedUris.size}枚選択中",
                            style = MaterialTheme.typography.titleMedium
                        )
                    },
                    actions = {
                        // Select all
                        TextButton(onClick = {
                            selectedUris = selectedImages.toSet()
                        }) {
                            Text("全選択")
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.primaryContainer
                    )
                )
            } else {
                TopAppBar(
                    title = {
                        Text(
                            "InstaFrame",
                            style = MaterialTheme.typography.headlineMedium
                        )
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.background
                    )
                )
            }
        },
        bottomBar = {
            if (selectionMode && selectedUris.isNotEmpty()) {
                Surface(
                    tonalElevation = 3.dp,
                    shadowElevation = 8.dp
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        // Single edit (first selected)
                        OutlinedButton(
                            onClick = {
                                selectedUris.firstOrNull()?.let {
                                    onImageSelected(it.toString())
                                }
                                exitSelectionMode()
                            },
                            modifier = Modifier.weight(1f)
                        ) {
                            Icon(Icons.Outlined.Edit, null, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(6.dp))
                            Text("1枚編集")
                        }

                        // Batch frame
                        Button(
                            onClick = {
                                onNavigateToBatchEdit(selectedUris.map { it.toString() })
                                exitSelectionMode()
                            },
                            modifier = Modifier.weight(1f)
                        ) {
                            Icon(Icons.Filled.AutoAwesome, null, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(6.dp))
                            Text("${selectedUris.size}枚にフレーム追加")
                        }
                    }
                }
            }
        },
        floatingActionButton = {
            if (!selectionMode) {
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    FloatingActionButton(
                        onClick = onNavigateToCamera,
                        containerColor = MaterialTheme.colorScheme.surfaceVariant,
                        contentColor = MaterialTheme.colorScheme.onSurface
                    ) {
                        Icon(Icons.Outlined.CameraAlt, "カメラを開く")
                    }
                    ExtendedFloatingActionButton(
                        onClick = { singleImageLauncher.launch(arrayOf("image/*")) },
                        icon = { Icon(Icons.Outlined.Add, null) },
                        text = { Text("写真を選択") },
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary
                    )
                }
            }
        }
    ) { padding ->
        Column(
            modifier = modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            if (selectedImages.isEmpty()) {
                EmptyGalleryState(
                    onSelectImages = { singleImageLauncher.launch(arrayOf("image/*")) },
                    onOpenCamera = onNavigateToCamera
                )
            } else {
                // Multi-select hint banner
                if (!selectionMode) {
                    Surface(color = MaterialTheme.colorScheme.surfaceVariant) {
                        Text(
                            "長押しで複数選択 → まとめてフレーム追加",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)
                        )
                    }
                }

                LazyVerticalGrid(
                    columns = GridCells.Fixed(3),
                    contentPadding = PaddingValues(4.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    items(selectedImages) { uri ->
                        val isSelected = uri in selectedUris
                        GalleryImageItem(
                            uri = uri,
                            isSelected = isSelected,
                            selectionMode = selectionMode,
                            onClick = {
                                if (selectionMode) {
                                    selectedUris = if (isSelected) {
                                        selectedUris - uri
                                    } else {
                                        selectedUris + uri
                                    }
                                    if (selectedUris.isEmpty()) exitSelectionMode()
                                } else {
                                    onImageSelected(uri.toString())
                                }
                            },
                            onLongClick = {
                                if (!selectionMode) {
                                    selectionMode = true
                                    selectedUris = setOf(uri)
                                }
                            }
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun EmptyGalleryState(
    onSelectImages: () -> Unit,
    onOpenCamera: () -> Unit
) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(24.dp)
        ) {
            Icon(
                Icons.Outlined.PhotoLibrary,
                contentDescription = null,
                modifier = Modifier.size(80.dp),
                tint = MaterialTheme.colorScheme.outline
            )
            Text(
                "写真を選択して編集を始めましょう",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                OutlinedButton(onClick = onOpenCamera) {
                    Icon(Icons.Outlined.CameraAlt, null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("カメラ")
                }
                Button(onClick = onSelectImages) {
                    Icon(Icons.Outlined.Add, null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("写真を選択")
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun GalleryImageItem(
    uri: Uri,
    isSelected: Boolean,
    selectionMode: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit
) {
    val context = LocalContext.current

    Box(
        modifier = Modifier
            .aspectRatio(1f)
            .clip(RoundedCornerShape(8.dp))
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
    ) {
        AsyncImage(
            model = ImageRequest.Builder(context)
                .data(uri)
                .crossfade(true)
                .build(),
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize()
        )

        // Selection overlay
        if (selectionMode) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(
                        if (isSelected) Color(0x662196F3) else Color(0x22000000)
                    )
            )
            // Checkbox indicator
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(6.dp)
                    .size(22.dp)
                    .clip(CircleShape)
                    .background(if (isSelected) Color(0xFF2196F3) else Color(0x88FFFFFF)),
                contentAlignment = Alignment.Center
            ) {
                if (isSelected) {
                    Icon(
                        Icons.Filled.Check,
                        contentDescription = null,
                        tint = Color.White,
                        modifier = Modifier.size(14.dp)
                    )
                }
            }
        }
    }
}

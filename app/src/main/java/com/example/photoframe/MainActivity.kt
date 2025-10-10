package com.example.photoframe

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts.OpenMultipleDocuments
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            PhotoFrameApp()
        }
    }
}

@Composable
fun PhotoFrameApp() {
    val context = LocalContext.current
    var selectedUris by remember { mutableStateOf<List<Uri>>(emptyList()) }
    var aspectRatio by remember { mutableStateOf(1f) }
    var showDate by remember { mutableStateOf(true) }
    var showCamera by remember { mutableStateOf(true) }

    val launcher = rememberLauncherForActivityResult(contract = OpenMultipleDocuments()) { uris: List<Uri> ->
        // Persist permission for URIs
        uris.forEach { uri ->
            context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        selectedUris = uris
    }

    Scaffold(topBar = {
        TopAppBar(title = { Text("Photo Frame") })
    }) { padding ->
        Column(modifier = Modifier
            .padding(padding)
            .fillMaxSize()) {
            Row(modifier = Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Button(onClick = { launcher.launch(arrayOf("image/*")) }) {
                    Text("Select Photos")
                }
                Spacer(modifier = Modifier.width(8.dp))
                Text("Aspect")
                Slider(value = aspectRatio, onValueChange = { aspectRatio = it }, valueRange = 0.5f..2f, modifier = Modifier.width(200.dp))
            }

            Row(modifier = Modifier.padding(8.dp)) {
                Checkbox(checked = showDate, onCheckedChange = { showDate = it })
                Text("Show Date")
                Spacer(modifier = Modifier.width(12.dp))
                Checkbox(checked = showCamera, onCheckedChange = { showCamera = it })
                Text("Show Camera")
            }

            Divider()

            LazyColumn(modifier = Modifier.fillMaxSize()) {
                items(selectedUris) { uri ->
                    Card(modifier = Modifier
                        .padding(8.dp)
                        .fillMaxWidth()) {
                        Column(modifier = Modifier.padding(8.dp)) {
                            // Use ImageProcessor to create framed bitmap in a coroutine
                            var processedBitmap by remember { mutableStateOf<android.graphics.Bitmap?>(null) }
                            LaunchedEffect(uri, aspectRatio, showDate, showCamera) {
                                val bmp = withContext(Dispatchers.IO) {
                                    ImageProcessor.createFramedBitmap(context, uri, aspectRatio, showDate, showCamera)
                                }
                                processedBitmap = bmp
                            }

                            if (processedBitmap != null) {
                                androidx.compose.foundation.Image(bitmap = processedBitmap!!.asImageBitmap(), contentDescription = null, modifier = Modifier.fillMaxWidth().height(300.dp))
                            } else {
                                Text("Processing...")
                            }
                        }
                    }
                }
            }
        }
    }
}

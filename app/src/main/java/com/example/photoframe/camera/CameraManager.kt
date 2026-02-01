package com.example.photoframe.camera

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.example.photoframe.data.FilterPreset
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * CameraXを使用したカメラマネージャー
 * リアルタイムフィルター付きカメラ機能を提供
 */
class CameraManager(private val context: Context) {
    
    companion object {
        private const val TAG = "CameraManager"
        private const val FILENAME_FORMAT = "yyyy-MM-dd-HH-mm-ss-SSS"
    }
    
    private var cameraProvider: ProcessCameraProvider? = null
    private var preview: Preview? = null
    private var imageCapture: ImageCapture? = null
    private var imageAnalyzer: ImageAnalysis? = null
    private var camera: Camera? = null
    
    private val cameraExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    
    private val _cameraState = MutableStateFlow<CameraState>(CameraState.Idle)
    val cameraState: StateFlow<CameraState> = _cameraState.asStateFlow()
    
    private val _currentLensFacing = MutableStateFlow(CameraSelector.LENS_FACING_BACK)
    val currentLensFacing: StateFlow<Int> = _currentLensFacing.asStateFlow()
    
    private val _flashMode = MutableStateFlow(ImageCapture.FLASH_MODE_OFF)
    val flashMode: StateFlow<Int> = _flashMode.asStateFlow()
    
    private val _zoomRatio = MutableStateFlow(1f)
    val zoomRatio: StateFlow<Float> = _zoomRatio.asStateFlow()
    
    private var currentFilter: FilterPreset? = null
    
    /**
     * カメラを初期化してプレビューを開始
     */
    fun startCamera(
        lifecycleOwner: LifecycleOwner,
        previewView: PreviewView,
        onError: (Exception) -> Unit = {}
    ) {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(context)
        
        cameraProviderFuture.addListener({
            try {
                cameraProvider = cameraProviderFuture.get()
                bindCameraUseCases(lifecycleOwner, previewView)
                _cameraState.value = CameraState.Ready
            } catch (e: Exception) {
                Log.e(TAG, "Camera initialization failed", e)
                _cameraState.value = CameraState.Error(e.message ?: "Unknown error")
                onError(e)
            }
        }, ContextCompat.getMainExecutor(context))
    }
    
    private fun bindCameraUseCases(
        lifecycleOwner: LifecycleOwner,
        previewView: PreviewView
    ) {
        val cameraProvider = cameraProvider ?: throw IllegalStateException("Camera provider not initialized")
        
        // プレビュー設定
        preview = Preview.Builder()
            .setTargetAspectRatio(AspectRatio.RATIO_4_3)
            .build()
            .also {
                it.setSurfaceProvider(previewView.surfaceProvider)
            }
        
        // 画像キャプチャ設定
        imageCapture = ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
            .setTargetAspectRatio(AspectRatio.RATIO_4_3)
            .setFlashMode(_flashMode.value)
            .build()
        
        // 画像解析設定（リアルタイムフィルター用）
        imageAnalyzer = ImageAnalysis.Builder()
            .setTargetAspectRatio(AspectRatio.RATIO_4_3)
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
        
        val cameraSelector = CameraSelector.Builder()
            .requireLensFacing(_currentLensFacing.value)
            .build()
        
        try {
            cameraProvider.unbindAll()
            camera = cameraProvider.bindToLifecycle(
                lifecycleOwner,
                cameraSelector,
                preview,
                imageCapture,
                imageAnalyzer
            )
            
            // ズーム制御を設定
            camera?.cameraControl?.setZoomRatio(_zoomRatio.value)
            
        } catch (e: Exception) {
            Log.e(TAG, "Use case binding failed", e)
            throw e
        }
    }
    
    /**
     * 写真を撮影して保存
     */
    fun takePhoto(
        onSuccess: (String) -> Unit,
        onError: (Exception) -> Unit
    ) {
        val imageCapture = imageCapture ?: run {
            onError(IllegalStateException("Camera not initialized"))
            return
        }
        
        _cameraState.value = CameraState.Capturing
        
        val name = SimpleDateFormat(FILENAME_FORMAT, Locale.US)
            .format(System.currentTimeMillis())
        
        val contentValues = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, "InstaFrame_$name")
            put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg")
            if (Build.VERSION.SDK_INT > Build.VERSION_CODES.P) {
                put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/InstaFrame")
            }
        }
        
        val outputOptions = ImageCapture.OutputFileOptions.Builder(
            context.contentResolver,
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            contentValues
        ).build()
        
        imageCapture.takePicture(
            outputOptions,
            ContextCompat.getMainExecutor(context),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                    val savedUri = output.savedUri?.toString() ?: ""
                    Log.d(TAG, "Photo saved: $savedUri")
                    _cameraState.value = CameraState.Ready
                    onSuccess(savedUri)
                }
                
                override fun onError(exception: ImageCaptureException) {
                    Log.e(TAG, "Photo capture failed", exception)
                    _cameraState.value = CameraState.Error(exception.message ?: "Capture failed")
                    onError(exception)
                }
            }
        )
    }
    
    /**
     * 前面/背面カメラを切り替え
     */
    fun switchCamera(lifecycleOwner: LifecycleOwner, previewView: PreviewView) {
        _currentLensFacing.value = if (_currentLensFacing.value == CameraSelector.LENS_FACING_BACK) {
            CameraSelector.LENS_FACING_FRONT
        } else {
            CameraSelector.LENS_FACING_BACK
        }
        
        cameraProvider?.let {
            bindCameraUseCases(lifecycleOwner, previewView)
        }
    }
    
    /**
     * フラッシュモードを切り替え
     */
    fun toggleFlash() {
        _flashMode.value = when (_flashMode.value) {
            ImageCapture.FLASH_MODE_OFF -> ImageCapture.FLASH_MODE_ON
            ImageCapture.FLASH_MODE_ON -> ImageCapture.FLASH_MODE_AUTO
            else -> ImageCapture.FLASH_MODE_OFF
        }
        imageCapture?.flashMode = _flashMode.value
    }
    
    /**
     * ズームを設定
     */
    fun setZoom(ratio: Float) {
        val clampedRatio = ratio.coerceIn(1f, 10f)
        _zoomRatio.value = clampedRatio
        camera?.cameraControl?.setZoomRatio(clampedRatio)
    }
    
    /**
     * フォーカスをタップ位置に設定
     */
    fun focusOnPoint(x: Float, y: Float, previewView: PreviewView) {
        val factory = previewView.meteringPointFactory
        val point = factory.createPoint(x, y)
        val action = FocusMeteringAction.Builder(point)
            .setAutoCancelDuration(3, java.util.concurrent.TimeUnit.SECONDS)
            .build()
        camera?.cameraControl?.startFocusAndMetering(action)
    }
    
    /**
     * フィルターを設定（リアルタイムプレビュー用）
     */
    fun setFilter(filter: FilterPreset) {
        currentFilter = filter
        // 実際のフィルター適用はImageAnalysisコールバック内で行う
    }
    
    /**
     * リソースを解放
     */
    fun shutdown() {
        cameraExecutor.shutdown()
        cameraProvider?.unbindAll()
        _cameraState.value = CameraState.Idle
    }
}

/**
 * カメラの状態
 */
sealed class CameraState {
    object Idle : CameraState()
    object Ready : CameraState()
    object Capturing : CameraState()
    data class Error(val message: String) : CameraState()
}

package com.example.photoframe.utils

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.exifinterface.media.ExifInterface
import com.example.photoframe.processing.ExifData
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream

/**
 * 画像保存・読み込みユーティリティ
 */
object ImageUtils {

    /**
     * Bitmapをギャラリーに保存
     */
    suspend fun saveBitmapToGallery(
        context: Context,
        bitmap: Bitmap,
        fileName: String = "InstaFrame_${System.currentTimeMillis()}",
        quality: Int = 95
    ): Uri? = withContext(Dispatchers.IO) {
        try {
            val contentValues = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg")
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/InstaFrame")
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
            }

            val resolver = context.contentResolver
            val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, contentValues)

            uri?.let { savedUri ->
                resolver.openOutputStream(savedUri)?.use { outputStream ->
                    bitmap.compress(Bitmap.CompressFormat.JPEG, quality, outputStream)
                }

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    contentValues.clear()
                    contentValues.put(MediaStore.MediaColumns.IS_PENDING, 0)
                    resolver.update(savedUri, contentValues, null, null)
                }
            }

            uri
        } catch (e: Exception) {
            e.printStackTrace()
            null
        }
    }

    /**
     * URIからEXIF情報を読み取る
     */
    suspend fun readExifData(context: Context, uri: Uri): ExifData? = withContext(Dispatchers.IO) {
        try {
            context.contentResolver.openInputStream(uri)?.use { inputStream ->
                val exif = ExifInterface(inputStream)
                
                ExifData(
                    make = exif.getAttribute(ExifInterface.TAG_MAKE),
                    model = exif.getAttribute(ExifInterface.TAG_MODEL),
                    lensModel = exif.getAttribute(ExifInterface.TAG_LENS_MODEL),
                    focalLength = exif.getAttribute(ExifInterface.TAG_FOCAL_LENGTH)?.let {
                        val parts = it.split("/")
                        if (parts.size == 2) {
                            (parts[0].toDoubleOrNull() ?: 0.0) / (parts[1].toDoubleOrNull() ?: 1.0)
                        } else {
                            it.toDoubleOrNull()
                        }?.let { focal -> "%.0f".format(focal) }
                    },
                    fNumber = exif.getAttribute(ExifInterface.TAG_F_NUMBER)?.let {
                        val parts = it.split("/")
                        if (parts.size == 2) {
                            (parts[0].toDoubleOrNull() ?: 0.0) / (parts[1].toDoubleOrNull() ?: 1.0)
                        } else {
                            it.toDoubleOrNull()
                        }?.let { f -> "%.1f".format(f) }
                    },
                    exposureTime = exif.getAttribute(ExifInterface.TAG_EXPOSURE_TIME)?.let {
                        val value = it.toDoubleOrNull() ?: return@let null
                        if (value < 1) {
                            "1/${(1 / value).toInt()}"
                        } else {
                            "${value}s"
                        }
                    },
                    iso = exif.getAttributeInt(ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY, -1)
                        .takeIf { it > 0 },
                    dateTime = exif.getAttribute(ExifInterface.TAG_DATETIME)
                )
            }
        } catch (e: Exception) {
            e.printStackTrace()
            null
        }
    }

    /**
     * EXIF情報を保存画像にコピー
     */
    suspend fun copyExifData(
        context: Context,
        sourceUri: Uri,
        destUri: Uri
    ) = withContext(Dispatchers.IO) {
        try {
            // 元のEXIFを読み取り
            val sourceExif = context.contentResolver.openInputStream(sourceUri)?.use {
                ExifInterface(it)
            } ?: return@withContext

            // 保存先に書き込み
            context.contentResolver.openFileDescriptor(destUri, "rw")?.use { pfd ->
                val destExif = ExifInterface(pfd.fileDescriptor)
                
                // コピーする属性のリスト
                val attributesToCopy = listOf(
                    ExifInterface.TAG_MAKE,
                    ExifInterface.TAG_MODEL,
                    ExifInterface.TAG_DATETIME,
                    ExifInterface.TAG_DATETIME_ORIGINAL,
                    ExifInterface.TAG_GPS_LATITUDE,
                    ExifInterface.TAG_GPS_LATITUDE_REF,
                    ExifInterface.TAG_GPS_LONGITUDE,
                    ExifInterface.TAG_GPS_LONGITUDE_REF,
                    ExifInterface.TAG_FOCAL_LENGTH,
                    ExifInterface.TAG_F_NUMBER,
                    ExifInterface.TAG_EXPOSURE_TIME,
                    ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY,
                    ExifInterface.TAG_LENS_MODEL,
                    ExifInterface.TAG_ORIENTATION
                )
                
                attributesToCopy.forEach { tag ->
                    sourceExif.getAttribute(tag)?.let { value ->
                        destExif.setAttribute(tag, value)
                    }
                }
                
                // InstaFrameで編集したことを記録
                destExif.setAttribute(ExifInterface.TAG_SOFTWARE, "InstaFrame")
                
                destExif.saveAttributes()
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
}

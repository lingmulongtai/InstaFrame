package com.example.photoframe.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.example.photoframe.camera.CameraManager
import com.example.photoframe.camera.CameraScreen
import com.example.photoframe.ui.screens.EditScreen
import com.example.photoframe.ui.screens.GalleryScreen
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * アプリナビゲーション定義
 */
sealed class Screen(val route: String) {
    object Gallery : Screen("gallery")
    object Camera : Screen("camera")
    object Edit : Screen("edit/{imageUri}") {
        fun createRoute(imageUri: String): String {
            val encoded = URLEncoder.encode(imageUri, StandardCharsets.UTF_8.toString())
            return "edit/$encoded"
        }
    }
}

@Composable
fun InstaFrameNavigation(
    navController: NavHostController = rememberNavController(),
    startDestination: String = Screen.Gallery.route
) {
    val context = LocalContext.current
    val cameraManager = remember { CameraManager(context) }
    
    NavHost(
        navController = navController,
        startDestination = startDestination
    ) {
        // ギャラリー画面
        composable(Screen.Gallery.route) {
            GalleryScreen(
                onImageSelected = { uri ->
                    navController.navigate(Screen.Edit.createRoute(uri))
                },
                onNavigateToCamera = {
                    navController.navigate(Screen.Camera.route)
                }
            )
        }
        
        // カメラ画面
        composable(Screen.Camera.route) {
            CameraScreen(
                cameraManager = cameraManager,
                onPhotoTaken = { /* 撮影完了 */ },
                onNavigateToGallery = {
                    navController.popBackStack()
                },
                onNavigateToEdit = { uri ->
                    navController.navigate(Screen.Edit.createRoute(uri)) {
                        popUpTo(Screen.Camera.route) { inclusive = true }
                    }
                }
            )
        }
        
        // 編集画面
        composable(
            route = Screen.Edit.route,
            arguments = listOf(
                navArgument("imageUri") { type = NavType.StringType }
            )
        ) { backStackEntry ->
            val encodedUri = backStackEntry.arguments?.getString("imageUri") ?: ""
            val imageUri = URLDecoder.decode(encodedUri, StandardCharsets.UTF_8.toString())
            
            EditScreen(
                imageUri = imageUri,
                onSave = { bitmap ->
                    // TODO: 保存処理
                    navController.popBackStack()
                },
                onBack = {
                    navController.popBackStack()
                }
            )
        }
    }
}

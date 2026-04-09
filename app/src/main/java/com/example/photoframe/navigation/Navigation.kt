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
import com.example.photoframe.ui.screens.BatchEditScreen
import com.example.photoframe.ui.screens.EditScreen
import com.example.photoframe.ui.screens.GalleryScreen
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * App navigation definition
 */
sealed class Screen(val route: String) {
    object Gallery : Screen("gallery")
    object Camera  : Screen("camera")
    object Edit : Screen("edit/{imageUri}") {
        fun createRoute(imageUri: String): String {
            val encoded = URLEncoder.encode(imageUri, StandardCharsets.UTF_8.toString())
            return "edit/$encoded"
        }
    }
    object BatchEdit : Screen("batch_edit/{uriList}") {
        fun createRoute(uris: List<String>): String {
            // Join URIs with a separator and encode the whole thing
            val joined = uris.joinToString("|||")
            val encoded = URLEncoder.encode(joined, StandardCharsets.UTF_8.toString())
            return "batch_edit/$encoded"
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
        // Gallery screen
        composable(Screen.Gallery.route) {
            GalleryScreen(
                onImageSelected = { uri ->
                    navController.navigate(Screen.Edit.createRoute(uri))
                },
                onNavigateToCamera = {
                    navController.navigate(Screen.Camera.route)
                },
                onNavigateToBatchEdit = { uris ->
                    navController.navigate(Screen.BatchEdit.createRoute(uris))
                }
            )
        }

        // Camera screen
        composable(Screen.Camera.route) {
            CameraScreen(
                cameraManager = cameraManager,
                onPhotoTaken = { /* captured */ },
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

        // Single edit screen
        composable(
            route = Screen.Edit.route,
            arguments = listOf(navArgument("imageUri") { type = NavType.StringType })
        ) { backStackEntry ->
            val encodedUri = backStackEntry.arguments?.getString("imageUri") ?: ""
            val imageUri   = URLDecoder.decode(encodedUri, StandardCharsets.UTF_8.toString())
            EditScreen(
                imageUri = imageUri,
                onSave = { navController.popBackStack() },
                onBack = { navController.popBackStack() }
            )
        }

        // Batch edit screen
        composable(
            route = Screen.BatchEdit.route,
            arguments = listOf(navArgument("uriList") { type = NavType.StringType })
        ) { backStackEntry ->
            val encodedList = backStackEntry.arguments?.getString("uriList") ?: ""
            val uriList     = URLDecoder.decode(encodedList, StandardCharsets.UTF_8.toString())
                .split("|||")
                .filter { it.isNotBlank() }

            BatchEditScreen(
                imageUris  = uriList,
                onBack     = { navController.popBackStack() },
                onComplete = { navController.popBackStack() }
            )
        }
    }
}

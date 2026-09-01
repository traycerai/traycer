// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.4.2"),
        .package(name: "CapacitorApp", path: "../../../../../node_modules/.bun/@capacitor+app@8.1.1+f68449e264960a74/node_modules/@capacitor/app"),
        .package(name: "CapacitorAppLauncher", path: "../../../../../node_modules/.bun/@capacitor+app-launcher@8.0.1+f68449e264960a74/node_modules/@capacitor/app-launcher"),
        .package(name: "CapacitorBarcodeScanner", path: "../../../../../node_modules/.bun/@capacitor+barcode-scanner@3.1.0+f68449e264960a74/node_modules/@capacitor/barcode-scanner"),
        .package(name: "CapacitorDevice", path: "../../../../../node_modules/.bun/@capacitor+device@8.0.0+f68449e264960a74/node_modules/@capacitor/device"),
        .package(name: "CapacitorFilesystem", path: "../../../../../node_modules/.bun/@capacitor+filesystem@8.1.3+f68449e264960a74/node_modules/@capacitor/filesystem"),
        .package(name: "CapacitorKeyboard", path: "../../../../../node_modules/.bun/@capacitor+keyboard@8.0.5+f68449e264960a74/node_modules/@capacitor/keyboard"),
        .package(name: "CapacitorNetwork", path: "../../../../../node_modules/.bun/@capacitor+network@8.0.1+f68449e264960a74/node_modules/@capacitor/network"),
        .package(name: "CapacitorPushNotifications", path: "../../../../../node_modules/.bun/@capacitor+push-notifications@8.1.2+f68449e264960a74/node_modules/@capacitor/push-notifications"),
        .package(name: "CapacitorShare", path: "../../../../../node_modules/.bun/@capacitor+share@8.0.1+f68449e264960a74/node_modules/@capacitor/share"),
        .package(name: "CapacitorNativeSettings", path: "../../../../../node_modules/.bun/capacitor-native-settings@8.2.0+f68449e264960a74/node_modules/capacitor-native-settings"),
        .package(name: "CapacitorSecureStoragePlugin", path: "../../../../../node_modules/.bun/capacitor-secure-storage-plugin@0.13.0+f68449e264960a74/node_modules/capacitor-secure-storage-plugin")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "CapacitorAppLauncher", package: "CapacitorAppLauncher"),
                .product(name: "CapacitorBarcodeScanner", package: "CapacitorBarcodeScanner"),
                .product(name: "CapacitorDevice", package: "CapacitorDevice"),
                .product(name: "CapacitorFilesystem", package: "CapacitorFilesystem"),
                .product(name: "CapacitorKeyboard", package: "CapacitorKeyboard"),
                .product(name: "CapacitorNetwork", package: "CapacitorNetwork"),
                .product(name: "CapacitorPushNotifications", package: "CapacitorPushNotifications"),
                .product(name: "CapacitorShare", package: "CapacitorShare"),
                .product(name: "CapacitorNativeSettings", package: "CapacitorNativeSettings"),
                .product(name: "CapacitorSecureStoragePlugin", package: "CapacitorSecureStoragePlugin")
            ]
        )
    ]
)

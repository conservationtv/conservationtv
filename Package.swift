// swift-tools-version: 6.0
// The Swift half of the workspace: the versioned-API runtime, and the SDKs generated against it. At the root so an app
// can depend on this repository by URL. The generator is a package of its own (packages/versioned-api/swift/codegen),
// so apps never resolve its dependencies.
import PackageDescription

let package = Package(
    name: "conservationtv",
    platforms: [.iOS(.v16), .macOS(.v13), .tvOS(.v16), .watchOS(.v9), .visionOS(.v1)],
    products: [
        .library(name: "VersionedAPIClient", targets: ["VersionedAPIClient"]),
        .library(name: "ConservationTVStudioSDK", targets: ["ConservationTVStudioSDK"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.8.2"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.2.0"),
        .package(url: "https://github.com/apple/swift-http-types", from: "1.4.0"),
    ],
    targets: [
        .target(
            name: "VersionedAPIClient",
            dependencies: [
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
                .product(name: "HTTPTypes", package: "swift-http-types"),
            ],
            path: "packages/versioned-api/swift/Sources/VersionedAPIClient"
        ),
        .target(
            name: "ConservationTVStudioSDK",
            dependencies: [
                "VersionedAPIClient",
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
            ],
            path: "apps/studio/sdks/swift/Sources/ConservationTVStudioSDK"
        ),
    ]
)

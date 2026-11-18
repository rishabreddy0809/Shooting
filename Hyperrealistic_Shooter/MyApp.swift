import SwiftUI

@main struct MyApp: App {
    var body: some Scene {
        WindowGroup("Ridgeline") {
            ContentView()
        }
        #if os(macOS)
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1440, height: 860)
        #endif
    }
}

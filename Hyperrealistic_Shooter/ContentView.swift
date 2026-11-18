import SwiftUI

struct ContentView: View {
    var body: some View {
        #if os(macOS)
        GameScreen()
        #else
        Text("Ridgeline needs a keyboard and mouse. Run the Mac build to play.")
            .padding()
        #endif
    }
}

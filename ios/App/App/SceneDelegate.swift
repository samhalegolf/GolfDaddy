import UIKit
import Capacitor

/*
 iOS 27 refuses to launch apps that haven't adopted the scene lifecycle, so
 URL opens and user activities now arrive here instead of AppDelegate.
 The window and its root CAPBridgeViewController come from Main.storyboard,
 named in Info.plist's UIApplicationSceneManifest.
 */
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        // A URL or Universal Link that cold-launched the app.
        for context in connectionOptions.urlContexts {
            handleOpen(context)
        }
        if let activity = connectionOptions.userActivities.first {
            handleContinue(activity)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts {
            handleOpen(context)
        }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        handleContinue(userActivity)
    }

    private func handleOpen(_ context: UIOpenURLContext) {
        let url = context.url

        // Garmin Connect hands the chosen watch back on our own URL scheme
        // (see GarminTransport). Broadcast rather than call: the scene has
        // no handle on the plugin's transport and should not grow one, and a
        // URL arriving before the plugin loads is then simply unobserved.
        NotificationCenter.default.post(
            name: GarminTransport.openURLNotification, object: nil, userInfo: ["url": url]
        )

        // Keep Capacitor's App plugin informed so appUrlOpen still fires.
        var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
        if let source = context.options.sourceApplication {
            options[.sourceApplication] = source
        }
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: options)
    }

    private func handleContinue(_ userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared, continue: userActivity, restorationHandler: { _ in }
        )
    }
}

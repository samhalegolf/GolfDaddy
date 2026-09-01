import Foundation
import UIKit

/* Durable, on-wrist cache for one course's lite maps.

 The Watch has no network and no Supabase credentials by design: the phone is
 the only thing that can read course_watch_maps, so it pushes the manifest over
 transferUserInfo and each hole image over transferFile. Both are durable
 queues, so a package that starts arriving while the Watch app is closed still
 lands — and neither ordering is guaranteed, which is why an image is written
 purely from its own transfer metadata and reconciled with the manifest
 afterwards rather than being held back waiting for one.

 The filesystem is the state. `refresh()` re-reads what is actually on disk
 rather than trusting an in-memory tally, so a half-delivered package after a
 crash reports exactly the holes it really has.

 Layout: <Application Support>/CaddyWatchMaps/<courseKey>/v<version>/{manifest.json,hN.webp}
 A regenerated package lands under a new version folder and never overwrites an
 old one, so a partially replaced package can never mix two recipes' images. */
@MainActor
final class WatchMapStore: ObservableObject {
    struct Installed: Equatable {
        let manifest: WatchMapManifest
        let readyHoles: Set<Int>
        var isComplete: Bool { readyHoles.count == manifest.holes.count }
    }

    struct LoadedHoleMap: Equatable {
        let holeNumber: Int
        let image: UIImage
        let spatialReference: WatchMapSpatialReference
        static func == (lhs: LoadedHoleMap, rhs: LoadedHoleMap) -> Bool {
            lhs.holeNumber == rhs.holeNumber && lhs.image === rhs.image && lhs.spatialReference == rhs.spatialReference
        }
    }

    @Published private(set) var installed: Installed?

    private var imageCache: [Int: UIImage] = [:]
    private var cachedPackage: String?

    /* Constructed from WatchSessionManager's own stored-property initialiser,
       which is not yet on the main actor, so the first disk read is scheduled
       rather than performed here. Until it lands the store simply reports no
       package — the same honest state as a wrist that has never been sent one. */
    nonisolated init() {
        Task { @MainActor [weak self] in self?.refresh() }
    }

    // ------------------------------------------------------------------ reads

    /// The hole's map, or nil when this course/hole has no delivered image yet.
    /// A course key mismatch is a miss, never a wrong-course map.
    func hole(_ number: Int, courseKey: String?) -> LoadedHoleMap? {
        guard let installed, let courseKey, installed.manifest.courseKey == courseKey else { return nil }
        guard let hole = installed.manifest.hole(number), installed.readyHoles.contains(number) else { return nil }
        let packageKey = installed.manifest.courseKey + "/v\(installed.manifest.version)"
        if cachedPackage != packageKey { imageCache.removeAll(); cachedPackage = packageKey }
        if let cached = imageCache[number] {
            return LoadedHoleMap(holeNumber: number, image: cached, spatialReference: hole.spatialReference)
        }
        let url = Self.packageDirectory(courseKey: installed.manifest.courseKey, version: installed.manifest.version).appendingPathComponent(hole.asset)
        guard let image = UIImage(contentsOfFile: url.path) else { return nil }
        /* Eighteen flat 448px-wide images decode to a few megabytes in total,
           which the Watch will not thank us for holding all at once. Only the
           holes actually looked at this round stay resident. */
        if imageCache.count >= 4 { imageCache.removeAll() }
        imageCache[number] = image
        return LoadedHoleMap(holeNumber: number, image: image, spatialReference: hole.spatialReference)
    }

    /// What the phone needs in order to skip re-sending what is already here.
    func inventory() -> [String: Any] {
        guard let installed else { return ["holes": [Int]()] }
        return [
            "courseKey": installed.manifest.courseKey,
            "version": String(installed.manifest.version),
            "holes": installed.readyHoles.sorted()
        ]
    }

    // ----------------------------------------------------------------- writes

    /// Adopts a manifest pushed by the phone. Ignores anything malformed, and
    /// ignores an older package for a course we already hold a newer one for.
    func receive(manifest raw: Any) {
        guard JSONSerialization.isValidJSONObject(raw),
              let data = try? JSONSerialization.data(withJSONObject: raw),
              let manifest = try? JSONDecoder().decode(WatchMapManifest.self, from: data),
              manifest.isUsable else {
            NSLog("[CCWatch] watch map manifest rejected")
            return
        }
        if let installed, installed.manifest.courseKey == manifest.courseKey, installed.manifest.version > manifest.version { return }
        let directory = Self.packageDirectory(courseKey: manifest.courseKey, version: manifest.version)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try JSONEncoder().encode(manifest).write(to: directory.appendingPathComponent(Self.manifestName), options: .atomic)
        } catch {
            NSLog("[CCWatch] watch map manifest write failed: %@", String(describing: error))
            return
        }
        prune(keepingCourseKey: manifest.courseKey, version: manifest.version)
        refresh()
    }

    /// Re-reads the newest package on disk. Cheap enough (one directory listing)
    /// to be the single path by which published state ever changes.
    func refresh() {
        guard let package = Self.newestPackageOnDisk(), let manifest = Self.readManifest(at: package) else {
            if installed != nil { installed = nil; imageCache.removeAll(); cachedPackage = nil }
            return
        }
        let present = Set((try? FileManager.default.contentsOfDirectory(atPath: package.path)) ?? [])
        let ready = Set(manifest.holes.filter { present.contains($0.asset) }.map(\.holeNumber))
        let next = Installed(manifest: manifest, readyHoles: ready)
        if installed != next {
            installed = next
            imageCache.removeAll()
            cachedPackage = nil
        }
    }

    // ------------------------------------------- nonisolated transfer landing

    /* WatchConnectivity hands over a temporary file that is deleted the moment
       this returns, so the read has to happen inline on its own queue rather
       than being hopped onto the main actor first. A hole image is a few
       kilobytes, so reading it whole costs nothing and lets the queued-file and
       live-message paths share one landing. */
    nonisolated func acceptTransferredFile(at url: URL, metadata: [String: Any]?) {
        guard let bytes = try? Data(contentsOf: url) else {
            NSLog("[CCWatch] watch map asset unreadable at handover")
            return
        }
        accept(bytes: bytes, metadata: metadata)
    }

    /* Writing the same bytes to the same path twice is a no-op, which is what
       makes it safe for the phone to both mirror an asset live and queue it
       durably — the arrangement the Scene already uses, because the queued
       stores are unreliable on the simulator's two-target Watch app. */
    nonisolated func accept(bytes: Data, metadata: [String: Any]?) {
        guard !bytes.isEmpty,
              let metadata,
              let courseKey = metadata["courseKey"] as? String,
              let asset = metadata["asset"] as? String,
              let version = Self.int64(metadata["version"]),
              version > 0,
              WatchMapManifest.isValidCourseKey(courseKey),
              WatchMapManifest.isValidAssetName(asset) else {
            NSLog("[CCWatch] watch map asset rejected: bad transfer metadata")
            return
        }
        let directory = Self.packageDirectory(courseKey: courseKey, version: version)
        let destination = directory.appendingPathComponent(asset)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try bytes.write(to: destination, options: .atomic)
        } catch {
            NSLog("[CCWatch] watch map asset write failed for %@: %@", asset, String(describing: error))
            return
        }
        Task { @MainActor [weak self] in self?.refresh() }
    }

    // ----------------------------------------------------------------- layout

    private static let manifestName = "manifest.json"

    nonisolated private static func root() -> URL {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("CaddyWatchMaps", isDirectory: true)
    }

    nonisolated private static func packageDirectory(courseKey: String, version: Int64) -> URL {
        root().appendingPathComponent(courseKey, isDirectory: true).appendingPathComponent("v\(version)", isDirectory: true)
    }

    nonisolated private static func int64(_ value: Any?) -> Int64? {
        if let number = value as? NSNumber { return number.int64Value }
        if let text = value as? String { return Int64(text) }
        return nil
    }

    /* Package versions are millisecond timestamps, so "newest on disk" is a
       total order across courses too — which is what makes this recoverable
       when assets land before the manifest that names them. */
    private static func newestPackageOnDisk() -> URL? {
        let fileManager = FileManager.default
        guard let courses = try? fileManager.contentsOfDirectory(at: root(), includingPropertiesForKeys: nil) else { return nil }
        var best: (URL, Int64)?
        for course in courses {
            guard let versions = try? fileManager.contentsOfDirectory(at: course, includingPropertiesForKeys: nil) else { continue }
            for version in versions {
                guard version.lastPathComponent.hasPrefix("v"), let stamp = Int64(version.lastPathComponent.dropFirst()) else { continue }
                guard fileManager.fileExists(atPath: version.appendingPathComponent(manifestName).path) else { continue }
                if best == nil || stamp > best!.1 { best = (version, stamp) }
            }
        }
        return best?.0
    }

    private static func readManifest(at package: URL) -> WatchMapManifest? {
        guard let data = try? Data(contentsOf: package.appendingPathComponent(manifestName)),
              let manifest = try? JSONDecoder().decode(WatchMapManifest.self, from: data),
              manifest.isUsable else { return nil }
        return manifest
    }

    /* Only one course is ever in play, and a superseded package is dead weight
       on a device with very little room. Everything else goes. */
    private func prune(keepingCourseKey courseKey: String, version: Int64) {
        let fileManager = FileManager.default
        let keep = Self.packageDirectory(courseKey: courseKey, version: version)
        guard let courses = try? fileManager.contentsOfDirectory(at: Self.root(), includingPropertiesForKeys: nil) else { return }
        for course in courses {
            guard let versions = try? fileManager.contentsOfDirectory(at: course, includingPropertiesForKeys: nil) else {
                try? fileManager.removeItem(at: course)
                continue
            }
            for candidate in versions where candidate.standardizedFileURL != keep.standardizedFileURL {
                try? fileManager.removeItem(at: candidate)
            }
            if course.lastPathComponent != courseKey { try? fileManager.removeItem(at: course) }
        }
    }
}

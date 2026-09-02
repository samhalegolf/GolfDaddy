import SwiftUI
import WatchBubbleEngine

/* The two screens between one hole and the next.
 *
 * They exist because of what sits between a green and a tee: a walk. During it
 * a GPS position is not a position on either hole — it is behind one and in
 * front of the other — and every readout drawn from it is wrong in a way that
 * looks right. So neither of these screens reads a position at all. One holds
 * a score, the other holds a hole, and the round only starts taking GPS
 * seriously again when the wrist is standing in the next tee zone or the
 * player has said outright to start anyway. */

/* Hole complete. Nothing is asked of you: the score is already par, and the
   only thing to press is the next hole. */
struct HoleCompleteView: View {
    let holeNumber: Int?
    let par: Int?
    let score: Int?
    let nextHole: Int?
    let onStep: (Int) -> Void
    let onNext: () -> Void
    let onBack: () -> Void

    private var word: String {
        guard let score, let par else { return "Tap + to keep score" }
        switch score - par {
        case _ where score == 1: return "Hole in one"
        case ..<(-2): return "Albatross"
        case -2: return "Eagle"
        case -1: return "Birdie"
        case 0: return "Par"
        case 1: return "Bogey"
        default: return "\(score - par) over"
        }
    }

    var body: some View {
        VStack(spacing: 5) {
            Text("HOLE COMPLETE")
                .font(.system(size: 10, weight: .heavy)).kerning(1.2).foregroundStyle(.mint)
            Text(holeNumber.map { "Hole \($0)" } ?? "Hole")
                .font(.headline)
            HStack(spacing: 14) {
                Button { onStep(-1) } label: { Image(systemName: "minus") }
                    .buttonStyle(.bordered).tint(.gray)
                    .frame(width: 40)
                    .accessibilityLabel("One less")
                Text(score.map(String.init) ?? "–")
                    .font(.system(size: 34, weight: .black, design: .rounded)).monospacedDigit()
                    .frame(minWidth: 44)
                Button { onStep(1) } label: { Image(systemName: "plus") }
                    .buttonStyle(.bordered).tint(.gray)
                    .frame(width: 40)
                    .accessibilityLabel("One more")
            }
            Text(word)
                .font(.caption2.weight(.bold)).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Button(nextHole.map { "Next · hole \($0)" } ?? "End round", action: onNext)
                .buttonStyle(.borderedProminent).tint(.mint)
                .font(.callout.weight(.heavy))
            Button("Back to the green", action: onBack)
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
    }
}

/* The next hole, previewed.
 *
 * Framed on the hole — tee at the bottom, green at the top — and deliberately
 * NOT on where you are standing, which is still the last green. Play is
 * offered anyway: the tee zone presses it when you arrive, and the button is
 * how you say we are wrong about the tee. */
struct QueuedHoleView: View {
    let holeNumber: Int?
    let par: Int?
    let lengthM: Double?
    let toTeeM: Double?
    let atTee: Bool
    let map: WatchMapStore.LoadedHoleMap?
    let green: WatchScene.GeoPoint?
    let onPlay: () -> Void

    private var detail: String {
        [par.map { "Par \($0)" },
         lengthM.map { "\(Int($0.rounded())) m" },
         atTee ? "at the tee" : toTeeM.map { "\(Int($0.rounded())) m to the tee" }]
            .compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        VStack(spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text("NEXT UP").font(.system(size: 9, weight: .heavy)).kerning(1).foregroundStyle(.mint)
                Spacer()
                Text(holeNumber.map { "Hole \($0)" } ?? "Hole").font(.caption.weight(.heavy))
            }
            .padding(.horizontal, 4)
            /* The hole, drawn with no player on it. That absence IS the design:
               there is nowhere honest to put a dot until the round is taking
               this hole's geometry seriously. */
            if let map {
                HoleMapView(map: map, player: nil, green: green, target: nil)
                    .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                    .frame(maxHeight: .infinity)
            } else {
                VStack(spacing: 4) {
                    Image(systemName: "figure.walk").font(.title3).foregroundStyle(.secondary)
                    Text("Walk to the tee").font(.caption2).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(white: 0.09))
                .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
            }
            Text(detail)
                .font(.system(size: 10, weight: .bold)).foregroundStyle(.secondary)
                .lineLimit(1).minimumScaleFactor(0.7)
            Button(atTee ? "Play hole" : "Play this hole", action: onPlay)
                .buttonStyle(.borderedProminent).tint(.mint)
                .font(.callout.weight(.heavy))
                .accessibilityHint("Start this hole from where you are")
        }
        .padding(.horizontal, 3)
    }
}

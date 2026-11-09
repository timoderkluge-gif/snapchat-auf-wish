import AVFoundation
import ExpoModulesCore
import UIKit

// Ein Textbalken, Werte relativ zur Bildschirmhöhe der Vorschau (0...1)
struct Caption: Record {
  @Field var text: String = ""
  @Field var y: Double = 0       // Oberkante des Balkens
  @Field var height: Double = 0  // Balkenhöhe
  @Field var fontSize: Double = 0
}

final class ExportFailedException: GenericException<String> {
  override var reason: String { "Video-Export fehlgeschlagen: \(param)" }
}

public class VideoEditorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("VideoEditor")

    // Gibt die URI einer neuen .mov-Datei zurück
    AsyncFunction("exportAsync") { (uri: URL, captions: [Caption], muted: Bool) async throws -> String in
      try await exportVideo(uri: uri, captions: captions.filter { !$0.text.isEmpty }, muted: muted)
    }
  }
}

private func exportVideo(uri: URL, captions: [Caption], muted: Bool) async throws -> String {
  let asset = AVURLAsset(url: uri)
  guard let sourceVideo = try await asset.loadTracks(withMediaType: .video).first else {
    throw ExportFailedException("keine Videospur")
  }
  let duration = try await asset.load(.duration)
  let range = CMTimeRange(start: .zero, duration: duration)

  let composition = AVMutableComposition()
  guard let video = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
    throw ExportFailedException("Videospur konnte nicht angelegt werden")
  }
  try video.insertTimeRange(range, of: sourceVideo, at: .zero)

  if !muted, let sourceAudio = try await asset.loadTracks(withMediaType: .audio).first,
     let audio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
    try audio.insertTimeRange(range, of: sourceAudio, at: .zero)
  }

  let transform = try await sourceVideo.load(.preferredTransform)
  video.preferredTransform = transform

  // Ohne Text reicht Kopieren ohne Neukodierung (nur Ton weg)
  let preset = captions.isEmpty ? AVAssetExportPresetPassthrough : AVAssetExportPresetHighestQuality
  guard let session = AVAssetExportSession(asset: composition, presetName: preset) else {
    throw ExportFailedException("Export-Session nicht verfügbar")
  }

  if !captions.isEmpty {
    let naturalSize = try await sourceVideo.load(.naturalSize)
    let rotated = CGRect(origin: .zero, size: naturalSize).applying(transform)
    let size = CGSize(width: abs(rotated.width), height: abs(rotated.height))

    let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: video)
    layerInstruction.setTransform(transform, at: .zero)
    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = range
    instruction.layerInstructions = [layerInstruction]

    let videoComposition = AVMutableVideoComposition()
    videoComposition.renderSize = size
    videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
    videoComposition.instructions = [instruction]

    let parent = CALayer()
    parent.frame = CGRect(origin: .zero, size: size)
    let videoLayer = CALayer()
    videoLayer.frame = parent.frame
    parent.addSublayer(videoLayer)
    for caption in captions {
      parent.addSublayer(captionLayer(caption, in: size))
    }
    videoComposition.animationTool = AVVideoCompositionCoreAnimationTool(postProcessingAsVideoLayer: videoLayer, in: parent)
    session.videoComposition = videoComposition
  }

  let output = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mov")
  session.outputURL = output
  session.outputFileType = .mov

  await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
    session.exportAsynchronously { done.resume() }
  }
  guard session.status == .completed else {
    throw ExportFailedException(session.error?.localizedDescription ?? "Status \(session.status.rawValue)")
  }
  return output.absoluteString
}

// Balken über die volle Breite mit mittigem weißem Text.
// Die Vorschau zeigt das Video bildschirmfüllend ("cover"): auf iPhones mit hohem Display wird nur seitlich
// abgeschnitten, deshalb passen die relativen Höhen der Vorschau 1:1 auf das Video.
private func captionLayer(_ caption: Caption, in size: CGSize) -> CALayer {
  let barHeight = CGFloat(caption.height) * size.height
  // CoreAnimation-Ursprung liegt hier unten links, die Vorschau misst von oben
  let barY = size.height - CGFloat(caption.y) * size.height - barHeight

  let bar = CALayer()
  bar.frame = CGRect(x: 0, y: barY, width: size.width, height: barHeight)
  bar.backgroundColor = UIColor(white: 0, alpha: 0.55).cgColor

  let fontSize = CGFloat(caption.fontSize) * size.height
  let font = UIFont.systemFont(ofSize: fontSize)
  let text = CATextLayer()
  text.string = NSAttributedString(string: caption.text, attributes: [
    .font: font,
    .foregroundColor: UIColor.white,
  ])
  text.alignmentMode = .center
  text.isWrapped = true
  text.contentsScale = UIScreen.main.scale
  let textHeight = font.lineHeight
  text.frame = CGRect(x: 0, y: (barHeight - textHeight) / 2, width: size.width, height: textHeight)
  bar.addSublayer(text)
  return bar
}

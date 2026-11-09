import { useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, Alert, Animated, Dimensions, FlatList, Keyboard, Modal, PanResponder, Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';
// expo-image versteht die ph://-Links der Fotomediathek (React Natives Image in Expo Go nicht)
import { Image } from 'expo-image';
import { captureRef } from 'react-native-view-shot';
import { Album, Asset, AssetField, MediaType, Query, requestPermissionsAsync } from 'expo-media-library';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { useVideoPlayer, VideoView } from 'expo-video';
import { requireOptionalNativeModule } from 'expo';

const { width: W, height: H } = Dimensions.get('window');
const CAPTION_FONT = 20;
// Eigenes natives Modul (modules/video-editor); in Expo Go nicht vorhanden -> null
const VideoEditor = requireOptionalNativeModule('VideoEditor');
const CELL = W / 4;
const PAGE = 120;

// Start/Ende des Kalendertags (heute - daysBack) vor `yearsAgo` Jahren
export function dayRange(today, yearsAgo, daysBack = 0) {
  const start = new Date(today.getFullYear() - yearsAgo, today.getMonth(), today.getDate() - daysBack);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return [start.getTime(), end.getTime()];
}

// Fotos und Videos der ganzen Mediathek oder nur eines Albums
const imageQuery = (album) =>
  (album ? new Query().album(album) : new Query()).within(AssetField.MEDIA_TYPE, [MediaType.IMAGE, MediaType.VIDEO]);

// IDs aller geladenen Videos, damit Raster und Vollbild sie erkennen (IDs bleiben einfache Strings)
const videoIds = new Set();
const track = (meta) => { for (const m of meta) if (m.mediaType === MediaType.VIDEO) videoIds.add(m.id); return meta; };

// Ein Flashback pro Tag (heute, gestern, … vor 7 Tagen), nur Tage mit Fotos
async function loadFlashbacks(album) {
  const today = new Date();
  const days = Array.from({ length: 8 }, () => []);
  // shortcut: looks back 30 years, raise if older photos exist
  for (let y = 1; y <= 30; y++) {
    const [start] = dayRange(today, y, 7);
    const [, end] = dayRange(today, y, 0);
    const meta = await imageQuery(album)
      .gte(AssetField.CREATION_TIME, start)
      .lt(AssetField.CREATION_TIME, end)
      .orderBy({ key: AssetField.CREATION_TIME, ascending: true })
      .exeForMetadata();
    track(meta);
    for (const m of meta) {
      const d = days.findIndex((_, i) => {
        const [s, e] = dayRange(today, y, i);
        return m.creationTime >= s && m.creationTime < e;
      });
      if (d >= 0) days[d].push({ id: m.id, y });
    }
  }
  const result = [];
  for (let d = 0; d < days.length; d++) {
    if (!days[d].length) continue;
    const uris = days[d].map((p) => p.id);
    const subs = days[d].map((p) => (p.y === 1 ? 'vor 1 Jahr' : `vor ${p.y} Jahren`));
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - d);
    result.push({ key: String(d), title: `Flashback vom ${date.toLocaleDateString('de-DE', { day: 'numeric', month: 'long' })}`, uris, subs });
  }
  return result;
}

const fullDate = (ms) => new Date(ms).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });

// 10 zufällige Fotos
async function loadRandom(album) {
  const all = await imageQuery(album).exe();
  // shortcut: fetches every asset handle to pick 10, fine for tens of thousands of photos
  for (let i = all.length - 1; i > 0 && i >= all.length - 10; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const picked = all.slice(-10);
  const uris = picked.map((a) => a.id);
  const times = await Promise.all(picked.map((a) => a.getCreationTime()));
  const types = await Promise.all(picked.map((a) => a.getMediaType()));
  track(picked.map((a, i) => ({ id: a.id, mediaType: types[i] })));
  return { key: 'random', title: 'Zufällige Memories', uris, subs: times.map((t) => (t ? fullDate(t) : '')) };
}

// Alle Fotos des Vormonats (im Januar also Dezember des Vorjahres)
async function loadLastMonth(album) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 1);
  const meta = await imageQuery(album)
    .gte(AssetField.CREATION_TIME, start.getTime())
    .lt(AssetField.CREATION_TIME, end.getTime())
    .orderBy({ key: AssetField.CREATION_TIME, ascending: true })
    .exeForMetadata();
  track(meta);
  const uris = meta.map((m) => m.id);
  const month = start.toLocaleDateString('de-DE', { month: 'long' });
  return { key: 'month', title: `Mein ${month}-Rückblick`, uris, subs: meta.map((m) => fullDate(m.creationTime)) };
}

async function loadPhotos(offset, album) {
  const meta = await imageQuery(album)
    .orderBy({ key: AssetField.CREATION_TIME, ascending: false })
    .limit(PAGE)
    .offset(offset)
    .exeForMetadata();
  // Asset-IDs sind „ph://…“-Links: <Image> lädt damit nur eine passende Vorschau.
  // getUri() würde dagegen jedes Original (auch aus iCloud) komplett herunterladen.
  return track(meta).map((m) => m.id);
}

// Textbalken über die volle Breite, nur senkrecht verschiebbar
function Caption({ item, editing, onEdit, onChange, onDone, onMove, onHeight }) {
  const y = useRef(new Animated.Value(item.y)).current;
  const base = useRef(item.y);
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 4,
    onPanResponderMove: (_, g) => y.setValue(base.current + g.dy),
    onPanResponderRelease: (_, g) => { base.current += g.dy; onMove(base.current); },
    onPanResponderTerminate: (_, g) => { base.current += g.dy; onMove(base.current); },
  })).current;
  return (
    <Animated.View
      {...pan.panHandlers}
      onLayout={(e) => onHeight(e.nativeEvent.layout.height)}
      style={[styles.caption, { top: y }]}
    >
      {editing ? (
        <TextInput
          autoFocus
          value={item.text}
          onChangeText={onChange}
          onBlur={onDone}
          onSubmitEditing={onDone}
          returnKeyType="done"
          style={styles.captionText}
        />
      ) : (
        <Pressable onPress={onEdit}>
          <Text style={styles.captionText}>{item.text}</Text>
        </Pressable>
      )}
    </Animated.View>
  );
}

function VideoPreview({ uri, muted }) {
  const player = useVideoPlayer(uri, (p) => { p.loop = true; p.play(); });
  useEffect(() => { player.muted = muted; }, [muted, player]);
  return <VideoView player={player} style={{ flex: 1 }} contentFit="cover" nativeControls={false} />;
}

// Video aus der Mediathek, spielt nur, solange es aktiv ist.
// expo-video bekommt direkt den ph://-Link: getUri() liefert einen Dateipfad, auf den die App
// keine Leserechte hat ("you don't have permission to view it").
function LibraryVideo({ id, active }) {
  const player = useVideoPlayer(id, (p) => { p.loop = true; });
  useEffect(() => { if (active) player.play(); else player.pause(); }, [active, player]);
  return <VideoView player={player} style={{ width: W, height: H }} contentFit="contain" nativeControls={false} />;
}

export default function App() {
  const [flashbacks, setFlashbacks] = useState(null);
  const [photos, setPhotos] = useState([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [denied, setDenied] = useState(false);
  const [viewer, setViewer] = useState(null); // { uris, index, story }
  const [pos, setPos] = useState(0);
  const [screen, setScreen] = useState('camera');
  const [camPerm, requestCamPerm] = useCameraPermissions({ request: true });
  useMicrophonePermissions({ request: true });
  const camRef = useRef(null);
  const [facing, setFacing] = useState('back');
  const toCamera = () => { setFacing('back'); setScreen('camera'); }; // immer mit Außenkamera starten
  const [shot, setShot] = useState(null); // { uri, video, saved } – Vorschau nach der Aufnahme
  const [recording, setRecording] = useState(false);
  const [zoom, setZoom] = useState(0);
  const zoomRef = useRef(0);
  const applyZoom = (z) => { zoomRef.current = Math.min(1, Math.max(0, z)); setZoom(zoomRef.current); };

  // Zwei-Finger-Zoom auf dem Kamerabild
  const pinch = useRef({ d0: 0, z0: 0 }).current;
  const dist = (t) => Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY);
  const pinchPan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: (e) => e.nativeEvent.touches.length === 2,
    onMoveShouldSetPanResponder: (e) => e.nativeEvent.touches.length === 2,
    onPanResponderMove: (e) => {
      const t = e.nativeEvent.touches;
      if (t.length !== 2) return;
      if (!pinch.d0) { pinch.d0 = dist(t); pinch.z0 = zoomRef.current; return; }
      applyZoom(pinch.z0 + (dist(t) - pinch.d0) / 400);
    },
    onPanResponderRelease: () => { pinch.d0 = 0; },
    onPanResponderTerminate: () => { pinch.d0 = 0; },
  })).current;

  // Auslöser: kurz tippen = Foto, gedrückt halten = Video, dabei hochziehen = Zoom
  const hold = useRef({ timer: null, rec: false }).current;
  const shutterPan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false, // Aufnahme nicht an andere Gesten verlieren
    onPanResponderGrant: (e) => {
      hold.locY = e.nativeEvent.locationY; // Abstand Finger -> Oberkante des Knopfs
      hold.base = zoomRef.current;
      hold.timer = setTimeout(() => {
        hold.timer = null;
        hold.rec = true;
        setRecording(true);
        camRef.current?.recordAsync()
          .then((v) => v?.uri && setShot({ uri: v.uri, video: true }))
          .catch((e) => { console.error(e); Alert.alert('Video fehlgeschlagen', String(e?.message ?? e)); });
      }, 300);
    },
    // Zoom erst, wenn der Finger oben aus dem Knopf rausgezogen wird
    onPanResponderMove: (_, g) => { if (hold.rec) applyZoom(hold.base + Math.max(0, -g.dy - hold.locY) / 300); },
    onPanResponderRelease: () => {
      if (hold.timer) {
        clearTimeout(hold.timer);
        hold.timer = null;
        camRef.current?.takePictureAsync()
          .then((p) => setShot({ uri: p.uri, video: false }))
          .catch((e) => { console.error(e); Alert.alert('Foto fehlgeschlagen', String(e?.message ?? e)); });
      } else if (hold.rec) {
        hold.rec = false;
        camRef.current?.stopRecording();
        setRecording(false);
        applyZoom(hold.base);
      }
    },
  })).current;

  const [texts, setTexts] = useState([]); // { id, text, y }
  const [editing, setEditing] = useState(null);
  const [exporting, setExporting] = useState(false);
  const shotRef = useRef(null);
  useEffect(() => { setTexts([]); setEditing(null); }, [shot?.uri]);

  function tapPreview() {
    if (editing) return Keyboard.dismiss(); // erst aktuellen Text fertig machen
    const id = Date.now();
    setTexts((t) => [...t, { id, text: '', y: H * 0.35 }]);
    setEditing(id);
  }
  const updateText = (id, patch) => {
    setTexts((t) => t.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    setShot((s) => s && { ...s, saved: false });
  };
  const finishText = () => { setTexts((t) => t.filter((x) => x.text.trim())); setEditing(null); };

  // Foto mit Text: Bildschirmausschnitt (Foto + Texte) als neues Bild.
  // Video mit Text oder stumm: natives Modul rendert eine neue Datei (nur im eigenen App-Build).
  async function finalUri() {
    if (shot.video) {
      const caps = texts.filter((t) => t.text.trim());
      if (!VideoEditor || (!shot.muted && !caps.length)) return shot.uri;
      Keyboard.dismiss();
      setEditing(null);
      setExporting(true);
      try {
        return await VideoEditor.exportAsync(
          shot.uri,
          caps.map((t) => ({ text: t.text, y: t.y / H, height: (t.h ?? 40) / H, fontSize: CAPTION_FONT / H })),
          !!shot.muted,
        );
      } finally {
        setExporting(false);
      }
    }
    if (!texts.some((t) => t.text.trim())) return shot.uri;
    Keyboard.dismiss();
    setEditing(null);
    await new Promise((r) => setTimeout(r, 100)); // Tastatur/Cursor weg vor dem Screenshot
    return captureRef(shotRef, { format: 'jpg', quality: 0.92 });
  }

  async function saveShot() {
    try {
      // ins Album „Snapchat“ speichern, Album anlegen falls es fehlt
      const snap = await Album.get('Snapchat');
      const asset = await Asset.create(await finalUri(), snap ?? undefined);
      if (!snap) await Album.create('Snapchat', [asset]);
      if (shot.video) videoIds.add(asset.id);
      setPhotos((p) => [asset.id, ...p]);
      setShot((s) => s && { ...s, saved: true });
    } catch (e) {
      console.error(e);
      Alert.alert('Speichern fehlgeschlagen');
    }
  }

  const sendShot = async () => {
    try { await Share.share({ url: await finalUri() }); } catch (e) { console.error(e); }
  };

  // Expo Go kann Videos nicht neu rendern; Stumm und Text brauchen den eigenen App-Build mit dem VideoEditor-Modul
  function confirmVideo(action) {
    const lost = !VideoEditor && shot.video && (shot.muted || texts.some((t) => t.text.trim()));
    if (!lost) return action();
    Alert.alert(
      'Geht noch nicht in Expo Go',
      'Stummschalten und Text können erst mit einem eigenen App-Build ins Video übernommen werden. Jetzt wird das Video mit Ton und ohne Text gespeichert bzw. gesendet.',
      [{ text: 'Abbrechen', style: 'cancel' }, { text: 'Trotzdem', onPress: action }],
    );
  }
  const open = (v) => { setPos(v.index); setViewer(v); };
  const listRef = useRef(null);
  const dragY = useRef(new Animated.Value(0)).current;
  const close = () => { setViewer(null); dragY.setValue(0); };
  const springBack = () => Animated.spring(dragY, { toValue: 0, useNativeDriver: false }).start();
  // Nur klar senkrechte Wischer nach unten abfangen, waagerechtes Swipen bleibt bei der Liste
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_, g) => g.dy > 10 && g.dy > Math.abs(g.dx) * 2,
    onPanResponderMove: (_, g) => dragY.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_, g) => (g.dy > 120 || g.vy > 1 ? close() : springBack()),
    onPanResponderTerminate: springBack,
  })).current;
  const step = (dir) => {
    const i = pos + dir;
    if (i < 0 || i >= viewer.uris.length) return;
    listRef.current?.scrollToIndex({ index: i, animated: false });
    setPos(i);
  };

  const [album, setAlbum] = useState(null); // null = ganze Mediathek
  const gen = useRef(0); // verwirft Ergebnisse, die nach einem Albumwechsel noch eintrudeln

  async function reload(a) {
    const g = ++gen.current;
    setAlbum(a); setPhotos([]); setDone(false); setLoading(false); setFlashbacks(null);
    try {
      const first = await loadPhotos(0, a);
      if (g !== gen.current) return;
      setPhotos(first);
      setDone(first.length < PAGE);
      const cards = [...(await loadFlashbacks(a)), await loadRandom(a), await loadLastMonth(a)];
      if (g === gen.current) setFlashbacks(cards.filter((c) => c.uris.length));
    } catch (e) {
      console.error(e);
      if (g === gen.current) { setDone(true); setFlashbacks([]); }
    }
  }

  async function toggleAlbum() {
    if (album) return reload(null);
    const a = await Album.get('Snapchat');
    if (!a) return Alert.alert('Kein Album „Snapchat“ gefunden');
    reload(a);
  }

  async function more() {
    if (loading || done) return;
    const g = gen.current;
    setLoading(true);
    try {
      const next = await loadPhotos(photos.length, album);
      if (g !== gen.current) return;
      // neu aufgenommene Fotos verschieben den Offset, daher Doppelte rausfiltern
      setPhotos((p) => { const seen = new Set(p); return [...p, ...next.filter((u) => !seen.has(u))]; });
      if (next.length < PAGE) setDone(true);
    } catch (e) {
      console.error(e);
      setDone(true);
    }
    setLoading(false);
  }

  useEffect(() => {
    (async () => {
      const perm = await requestPermissionsAsync(false, ['photo']);
      if (!perm.granted) return setDenied(true);
      reload(null);
    })().catch(console.error);
  }, []);

  if (screen === 'camera') {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {camPerm?.granted ? (
          // mode "video": iOS behält dabei die Foto-Ausgabe, so gehen Foto und Video ohne Umschalten
          // Stabilisierung aus: sonst schneidet iOS beim Aufnahmestart das Bild zu (wirkt wie Zoom)
          <View style={{ flex: 1 }} {...pinchPan.panHandlers}>
            <CameraView ref={camRef} style={{ flex: 1 }} facing={facing} mode="video" zoom={zoom} videoStabilizationMode="off" />
          </View>
        ) : (
          <Pressable style={{ flex: 1, justifyContent: 'center' }} onPress={requestCamPerm}>
            <Text style={[styles.info, { textAlign: 'center' }]}>Tippen, um die Kamera zu erlauben</Text>
          </Pressable>
        )}
        <View style={styles.camBar}>
          <Pressable style={styles.galleryBtn} onPress={() => setScreen('gallery')} accessibilityLabel="Flashbacks und Fotos">
            {photos[0] && <Image source={{ uri: photos[0] }} style={StyleSheet.absoluteFill} />}
          </Pressable>
          <View
            {...shutterPan.panHandlers}
            style={[styles.shutter, recording && styles.shutterRec]}
            accessible
            accessibilityRole="button"
            accessibilityLabel="Tippen für Foto, halten für Video"
          />
          <Pressable
            style={styles.roundBtn}
            onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))}
            accessibilityLabel="Kamera wechseln"
          >
            <Text style={styles.roundIcon}>🔄</Text>
          </Pressable>
        </View>
        {shot && (
          <View style={StyleSheet.absoluteFill}>
            <View ref={shotRef} collapsable={false} style={{ flex: 1, backgroundColor: '#000' }}>
              <Pressable style={{ flex: 1 }} onPress={tapPreview}>
                {shot.video ? <VideoPreview uri={shot.uri} muted={!!shot.muted} /> : <Image source={{ uri: shot.uri }} style={{ flex: 1 }} />}
              </Pressable>
              {texts.map((t) => (
                <Caption
                  key={t.id}
                  item={t}
                  editing={editing === t.id}
                  onEdit={() => setEditing(t.id)}
                  onChange={(text) => updateText(t.id, { text })}
                  onDone={finishText}
                  onMove={(y) => updateText(t.id, { y })}
                  onHeight={(h) => setTexts((all) => all.map((x) => (x.id === t.id ? { ...x, h } : x)))}
                />
              ))}
            </View>
            <Pressable style={[styles.roundBtn, styles.closeBtn]} onPress={() => setShot(null)} accessibilityLabel="Verwerfen">
              <Text style={styles.roundIcon}>✕</Text>
            </Pressable>
            {shot.video && (
              <Pressable
                style={[styles.roundBtn, styles.muteBtn]}
                onPress={() => setShot((s) => ({ ...s, muted: !s.muted, saved: false }))}
                accessibilityLabel={shot.muted ? 'Ton einschalten' : 'Stumm schalten'}
              >
                <Text style={styles.roundIcon}>{shot.muted ? '🔇' : '🔊'}</Text>
              </Pressable>
            )}
            <View style={[styles.camBar, { paddingHorizontal: 20 }]}>
              <Pressable style={styles.roundBtn} onPress={() => confirmVideo(saveShot)} disabled={shot.saved} accessibilityLabel="Speichern">
                <Text style={styles.roundIcon}>{shot.saved ? '✅' : '⬇️'}</Text>
              </Pressable>
              <View style={{ flex: 1 }} />
              <Pressable style={styles.sendBtn} onPress={() => confirmVideo(sendShot)} accessibilityLabel="Senden an">
                <Text style={styles.albumText}>Senden an ➤</Text>
              </Pressable>
            </View>
            {exporting && (
              <View style={styles.exporting}>
                <ActivityIndicator size="large" color="#fff" />
                <Text style={[styles.albumText, { marginTop: 12 }]}>Video wird erstellt …</Text>
              </View>
            )}
          </View>
        )}
        <StatusBar style="light" />
      </View>
    );
  }

  if (denied) {
    return (
      <View style={styles.container}>
        <Text style={styles.info}>Bitte in den Einstellungen Zugriff auf Fotos erlauben.</Text>
        <Pressable style={[styles.roundBtn, styles.camFab]} onPress={toCamera} accessibilityLabel="Zur Kamera">
          <Text style={styles.roundIcon}>📷</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.appTitle}>Snapchat auf Wish</Text>
      <View style={styles.top}>
        {flashbacks === null && <Text style={styles.info}>Lade Flashbacks …</Text>}
        {flashbacks?.length === 0 && <Text style={styles.info}>Keine Flashbacks in den letzten 7 Tagen.</Text>}
        <FlatList
          data={flashbacks ?? []}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingRight: 8 }}
          renderItem={({ item }) => (
            <Pressable style={styles.card} onPress={() => open({ uris: item.uris, index: 0, story: item })}>
              <Image source={{ uri: item.uris[0] }} style={StyleSheet.absoluteFill} />
              <View style={styles.cardShade} />
              <Text style={styles.cardTitle}>{item.title}</Text>
              <Text style={styles.cardSub}>{item.uris.length} {item.uris.length === 1 ? 'Foto' : 'Fotos'}</Text>
            </Pressable>
          )}
        />
      </View>

      <View style={styles.divider} />

      <FlatList
        data={photos}
        numColumns={4}
        keyExtractor={(uri) => uri}
        onEndReached={more}
        onEndReachedThreshold={1}
        renderItem={({ item, index }) => (
          <Pressable onPress={() => open({ uris: photos, index })}>
            <Image source={{ uri: item }} style={styles.cell} />
            {videoIds.has(item) && <Text style={styles.playBadge}>▶</Text>}
          </Pressable>
        )}
      />

      <Pressable style={[styles.roundBtn, styles.camFab]} onPress={toCamera} accessibilityLabel="Zur Kamera">
        <Text style={styles.roundIcon}>📷</Text>
      </Pressable>
      <Pressable style={styles.albumBtn} onPress={toggleAlbum} accessibilityLabel="Album wechseln">
        <Text style={styles.albumText}>📁 {album ? 'Snapchat' : 'Mediathek'}</Text>
      </Pressable>

      <Modal visible={!!viewer} transparent animationType="fade" onRequestClose={close}>
        {viewer && (
          <Animated.View
            {...pan.panHandlers}
            style={{
              flex: 1,
              backgroundColor: dragY.interpolate({ inputRange: [0, H / 2], outputRange: ['#000f', '#0000'], extrapolate: 'clamp' }),
              transform: [{ translateY: dragY }],
            }}
          >
          <FlatList
            ref={listRef}
            data={viewer.uris}
            horizontal
            pagingEnabled
            initialScrollIndex={viewer.index}
            onMomentumScrollEnd={(e) => setPos(Math.round(e.nativeEvent.contentOffset.x / W))}
            getItemLayout={(_, i) => ({ length: W, offset: W * i, index: i })}
            keyExtractor={(uri) => uri}
            extraData={pos}
            renderItem={({ item, index }) => (
              <Pressable onPress={(e) => step(e.nativeEvent.locationX < W / 2 ? -1 : 1)}>
                {videoIds.has(item) ? (
                  <LibraryVideo id={item} active={index === pos} />
                ) : (
                  <Image source={{ uri: item }} style={{ width: W, height: H }} contentFit="contain" />
                )}
              </Pressable>
            )}
          />
          {viewer.story && (
            <View style={styles.storyHead} pointerEvents="none">
              <View style={styles.bars}>
                {viewer.uris.map((uri, i) => (
                  <View key={uri} style={[styles.bar, i === pos && styles.barActive]} />
                ))}
              </View>
              <Text style={styles.storyTitle}>{viewer.story.title}</Text>
              <Text style={styles.storySub}>{viewer.story.subs[pos]}</Text>
            </View>
          )}
          </Animated.View>
        )}
      </Modal>
      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', paddingTop: 50 },
  top: { height: H / 3, justifyContent: 'center' },
  // 1¾ Karten sichtbar, damit man sieht, dass es weitergeht
  card: { width: (W - 16) / 1.75, height: H / 3 - 16, marginLeft: 8, borderRadius: 14, overflow: 'hidden', justifyContent: 'flex-end', padding: 14 },
  cardShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.25)' },
  cardTitle: { color: '#fff', fontSize: 20, fontWeight: 'bold' },
  cardSub: { color: '#ddd', fontSize: 15, marginTop: 2 },
  cell: { width: CELL, height: CELL, borderWidth: 0.5, borderColor: '#000' },
  info: { color: '#aaa', margin: 16 },
  appTitle: { color: '#fff', fontSize: 30, fontWeight: 'bold', marginHorizontal: 16, marginBottom: 10 },
  roundBtn: { width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(40,40,40,0.85)', alignItems: 'center', justifyContent: 'center' },
  roundIcon: { fontSize: 24 },
  camFab: { position: 'absolute', left: 20, bottom: 40, width: 60, height: 60, borderRadius: 30 },
  albumBtn: { position: 'absolute', right: 20, bottom: 40, height: 60, paddingHorizontal: 18, borderRadius: 30, backgroundColor: 'rgba(40,40,40,0.85)', justifyContent: 'center' },
  albumText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  muteBtn: { position: 'absolute', top: 60, right: 20 },
  playBadge: { position: 'absolute', right: 4, bottom: 2, color: '#fff', fontSize: 14, textShadowColor: '#000', textShadowRadius: 3 },
  caption: { position: 'absolute', left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.55)', paddingVertical: 8, paddingHorizontal: 12 },
  captionText: { color: '#fff', fontSize: CAPTION_FONT, textAlign: 'center', padding: 0 },
  exporting: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  shutterRec: { backgroundColor: '#e33', borderColor: '#fff' },
  closeBtn: { position: 'absolute', top: 60, left: 20 },
  sendBtn: { height: 52, paddingHorizontal: 20, borderRadius: 26, backgroundColor: '#2a8cff', justifyContent: 'center' },
  camBar: { position: 'absolute', bottom: 40, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' },
  galleryBtn: { width: 52, height: 52, borderRadius: 10, overflow: 'hidden', borderWidth: 2, borderColor: '#fff', backgroundColor: '#333' },
  shutter: { width: 76, height: 76, borderRadius: 38, backgroundColor: '#fff', borderWidth: 5, borderColor: '#bbb' },
  divider: { height: 4, borderRadius: 2, backgroundColor: '#333', marginVertical: 10, marginHorizontal: 16 },
  storyHead: { position: 'absolute', top: 54, left: 8, right: 8 },
  bars: { flexDirection: 'row', gap: 4, marginBottom: 10 },
  storyTitle: { color: '#fff', fontSize: 17, fontWeight: 'bold', textShadowColor: '#000', textShadowRadius: 4 },
  storySub: { color: '#ddd', fontSize: 13, textShadowColor: '#000', textShadowRadius: 4 },
  bar: { flex: 1, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.35)' },
  barActive: { backgroundColor: '#fff' },
});

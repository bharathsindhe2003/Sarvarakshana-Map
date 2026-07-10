const firebaseConfig = {
  apiKey: "AIzaSyCGISwf0hk9UbvKVxeGyb5YH3d90CugWH0",
  authDomain: "demoapp-220e0.firebaseapp.com",
  databaseURL: "https://demoapp-220e0-default-rtdb.firebaseio.com",
  projectId: "demoapp-220e0",
  storageBucket: "demoapp-220e0.firebasestorage.app",
  messagingSenderId: "951299710394",
  appId: "1:951299710394:web:ef61759ece6e8cd9ab5183",
};

firebase.initializeApp(firebaseConfig);

const db = firebase.database();

let map;
let polyline = null;
let startMarker = null;
let endMarker = null;
let infoWindow = null;

function formatTimestamp(timestamp, uuid) {
  const date = new Date(timestamp * 1000);

  return `
      <div>
        <b>Field Worker</b><br>
        ${uuid}<br><br>
        <b>Date & Time</b><br>
        ${date.toLocaleString()}<br>
        ${timestamp}
      </div>
    `;
}

function setNoDataMessage(message) {
  const noDataElement = document.getElementById("nodata");

  if (!noDataElement) {
    return;
  }

  noDataElement.hidden = !message;
  noDataElement.textContent = message || "";
}

function parseLocationPoint(rawValue, timestamp, uuid) {
  if (typeof rawValue !== "string") {
    return null;
  }

  const match = rawValue.match(/saddr=([\-\d.]+),([\-\d.]+)/i);

  if (!match) {
    return null;
  }

  const lat = Number.parseFloat(match[1]);
  const lng = Number.parseFloat(match[2]);
  const parsedTimestamp = Number.parseInt(timestamp, 10);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(parsedTimestamp)) {
    return null;
  }

  return {
    lat,
    lng,
    timestamp: parsedTimestamp,
    uuid,
  };
}

function squaredDistanceToSegment(point, start, end) {
  const segmentLat = end.lat - start.lat;
  const segmentLng = end.lng - start.lng;
  const segmentLengthSquared = segmentLat * segmentLat + segmentLng * segmentLng;

  if (segmentLengthSquared === 0) {
    const deltaLat = point.lat - start.lat;
    const deltaLng = point.lng - start.lng;

    return deltaLat * deltaLat + deltaLng * deltaLng;
  }

  const projection = ((point.lat - start.lat) * segmentLat + (point.lng - start.lng) * segmentLng) / segmentLengthSquared;
  const clampedProjection = Math.max(0, Math.min(1, projection));
  const closestLat = start.lat + clampedProjection * segmentLat;
  const closestLng = start.lng + clampedProjection * segmentLng;
  const deltaLat = point.lat - closestLat;
  const deltaLng = point.lng - closestLng;

  return deltaLat * deltaLat + deltaLng * deltaLng;
}

function findPreviousPointForHover(path, hoveredLatLng) {
  if (!path.length) {
    return null;
  }

  if (path.length === 1) {
    return path[0];
  }

  const hoverPoint = {
    lat: hoveredLatLng.lat(),
    lng: hoveredLatLng.lng(),
  };

  let closestSegmentStart = path[0];
  let smallestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < path.length - 1; index += 1) {
    const distance = squaredDistanceToSegment(hoverPoint, path[index], path[index + 1]);

    if (distance < smallestDistance) {
      smallestDistance = distance;
      closestSegmentStart = path[index];
    }
  }

  return closestSegmentStart;
}

async function loadFieldWorkers() {
  const response = await fetch(`${firebaseConfig.databaseURL}/locations.json?shallow=true`);

  const locations = (await response.json()) || {};
  // const locations = snapshot.val() || {};

  const select = document.getElementById("fieldWorker");

  select.innerHTML = '<option value="" disabled>Select Field Worker</option>';

  Object.keys(locations).forEach((key) => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = key;
    select.appendChild(option);
  });

  // Default selection: FW_02
  if (locations["FW_02"]) {
    select.value = "FW_02";
    await drawPath("FW_02");
  } else {
    const keys = Object.keys(locations);
    if (keys.length) {
      select.value = keys[0];
      await drawPath(keys[0]);
    }
  }

  select.addEventListener("change", async (e) => {
    if (e.target.value) {
      await drawPath(e.target.value);
    }
  });
}

async function drawPath(uuid) {
  setNoDataMessage("");

  if (!map) {
    const { Map } = await google.maps.importLibrary("maps");

    map = new Map(document.getElementById("map"), {
      zoom: 15,
      center: {
        lat: 12.972442,
        lng: 77.580643,
      },
      mapId: "372bfbbf3b6b6f6a",
    });
  }

  // Remove previous polyline and markers
  if (polyline) polyline.setMap(null);
  if (startMarker) startMarker.setMap(null);
  if (endMarker) endMarker.setMap(null);

  const snapshot = await db.ref(`locations/${uuid}`).orderByKey().once("value");

  const path = [];

  snapshot.forEach((child) => {
    const point = parseLocationPoint(child.val(), child.key, uuid);

    if (point) {
      path.push(point);
    }
  });

  path.sort((left, right) => left.timestamp - right.timestamp);

  if (!path.length) {
    setNoDataMessage(`No GPS points found for ${uuid}.`);
    map.setCenter({
      lat: 12.972442,
      lng: 77.580643,
    });
    map.setZoom(15);
    return;
  }

  polyline = new google.maps.Polyline({
    path: path.map((p) => ({
      lat: p.lat,
      lng: p.lng,
    })),
    geodesic: true,
    strokeColor: "#FF0000",
    strokeOpacity: 1,
    strokeWeight: 5,
  });

  polyline.setMap(map);
  if (!infoWindow) {
    infoWindow = new google.maps.InfoWindow();
  }

  polyline.addListener("mousemove", (event) => {
    const previousPoint = findPreviousPointForHover(path, event.latLng);

    if (!previousPoint) {
      return;
    }

    infoWindow.setContent(formatTimestamp(previousPoint.timestamp, previousPoint.uuid));
    infoWindow.setPosition(event.latLng);
    infoWindow.open({
      map,
    });
  });

  polyline.addListener("mouseout", () => {
    infoWindow.close();
  });

  const bounds = new google.maps.LatLngBounds();

  path.forEach((point) => bounds.extend(point));

  map.fitBounds(bounds);

  startMarker = new google.maps.Marker({
    position: {
      lat: path[0].lat,
      lng: path[0].lng,
    },
    map,
    label: "S",
    title: "Start",
  });

  endMarker = new google.maps.Marker({
    position: {
      lat: path[path.length - 1].lat,
      lng: path[path.length - 1].lng,
    },
    map,
    label: "E",
    title: "End",
  });
}

loadFieldWorkers();

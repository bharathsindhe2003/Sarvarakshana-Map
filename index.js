const firebaseConfig = {
  apiKey: "AIzaSyDxwWanrz_T-FQICF89Vl6HGKS7TBixrek",
  authDomain: "sarvarakshana-development.firebaseapp.com",
  databaseURL: "https://sarvarakshana-development-default-rtdb.firebaseio.com",
  projectId: "sarvarakshana-development",
  storageBucket: "sarvarakshana-development.appspot.com",
  messagingSenderId: "345813046788",
  appId: "1:345813046788:web:a43b5531f81f21c8e90751",
  measurementId: "G-D9PJ9QT6C7",
};

firebase.initializeApp(firebaseConfig);

const db = firebase.database();

let map;
let polylines = [];
let startMarkers = [];
let endMarkers = [];
let infoWindow = null;

const mapColors = ["#d62828", "#1d4ed8", "#2a9d8f", "#f4a261", "#6d28d9", "#111827"];

function formatTimestamp(timestamp, uuid) {
  const date = new Date(timestamp * 1000);
  const dayLabel = date.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return `
      <div>
        <b>Field Worker</b><br>
        ${uuid}<br><br>
        <b>Day</b><br>
        ${dayLabel}<br><br>
        <b>Date & Time</b><br>
        ${date.toLocaleString()}<br>
        ${timestamp}
      </div>
    `;
}

function formatTimestampOption(timestamp) {
  const parsedTimestamp = Number.parseInt(timestamp, 10);

  if (!Number.isFinite(parsedTimestamp)) {
    return timestamp;
  }

  return `${new Date(parsedTimestamp * 1000).toLocaleString()} (${timestamp})`;
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
    dayKey: new Date(parsedTimestamp * 1000).toISOString().slice(0, 10),
  };
}

function populateSelect(select, options, placeholder, formatter = (value) => value) {
  select.innerHTML = "";

  const placeholderOption = document.createElement("option");
  placeholderOption.value = "";
  placeholderOption.textContent = placeholder;
  select.appendChild(placeholderOption);

  options.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = formatter(value);
    select.appendChild(option);
  });

  select.disabled = options.length === 0;
}

function populateTimestampSelect(select, timestamps) {
  select.innerHTML = "";

  const placeholderOption = document.createElement("option");
  placeholderOption.value = "";
  placeholderOption.textContent = "Select Timestamp";
  select.appendChild(placeholderOption);

  const allOption = document.createElement("option");
  allOption.value = "__all__";
  allOption.textContent = "All Timestamps";
  select.appendChild(allOption);

  timestamps.forEach((timestamp) => {
    const option = document.createElement("option");
    option.value = timestamp;
    option.textContent = formatTimestampOption(timestamp);
    select.appendChild(option);
  });

  select.disabled = timestamps.length === 0;
}

function updateSubmitButtonState() {
  const daySelect = document.getElementById("daySelect");
  const batchSelect = document.getElementById("batchSelect");
  const fieldWorkerSelect = document.getElementById("fieldWorker");
  const submitButton = document.getElementById("submitSelection");

  if (!submitButton) {
    return;
  }

  submitButton.disabled = !(daySelect.value && batchSelect.value && fieldWorkerSelect.value);
}

function clearMapOverlays() {
  polylines.forEach((line) => line.setMap(null));
  polylines = [];

  startMarkers.forEach((marker) => marker.setMap(null));
  endMarkers.forEach((marker) => marker.setMap(null));
  startMarkers = [];
  endMarkers = [];
}

async function loadNestedKeys(path) {
  const response = await fetch(`${firebaseConfig.databaseURL}/${path}.json?shallow=true`);
  const data = (await response.json()) || {};

  return Object.keys(data).sort();
}

function groupPointsByDay(path) {
  return path.reduce((groups, point) => {
    if (!groups[point.dayKey]) {
      groups[point.dayKey] = [];
    }

    groups[point.dayKey].push(point);
    return groups;
  }, {});
}

function buildTimestampTracks(workerData, uuid, selectedTimestamp) {
  const timestamps = Object.keys(workerData || {}).sort();
  const selectedKeys = selectedTimestamp && selectedTimestamp !== "__all__" ? [selectedTimestamp] : timestamps;

  return selectedKeys
    .filter((timestampKey) => workerData[timestampKey] && typeof workerData[timestampKey] === "object")
    .map((timestampKey) => {
      const path = Object.entries(workerData[timestampKey])
        .map(([timestamp, rawValue]) => parseLocationPoint(rawValue, timestamp, uuid))
        .filter(Boolean)
        .sort((left, right) => left.timestamp - right.timestamp);

      return {
        timestampKey,
        path,
      };
    })
    .filter((track) => track.path.length > 0);
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

function createTrackMarker(point, label, strokeColor, title) {
  return new google.maps.Marker({
    position: {
      lat: point.lat,
      lng: point.lng,
    },
    map,
    label: {
      text: label,
      color: "#ffffff",
      fontWeight: "700",
    },
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 10,
      fillColor: strokeColor,
      fillOpacity: 1,
      strokeColor: "#ffffff",
      strokeWeight: 2,
    },
    title,
  });
}

async function loadFieldWorkers() {
  const daySelect = document.getElementById("daySelect");
  const batchSelect = document.getElementById("batchSelect");
  const fieldWorkerSelect = document.getElementById("fieldWorker");
  const submitButton = document.getElementById("submitSelection");

  const resetFieldWorkers = () => {
    populateSelect(fieldWorkerSelect, [], "Select Field Worker");
  };

  const resetVillages = () => {
    populateSelect(batchSelect, [], "Select Village");
    resetFieldWorkers();
  };

  const updateWorkers = async (dayKey) => {
    resetFieldWorkers();
    updateSubmitButtonState();

    if (!dayKey || !batchSelect.value) {
      return;
    }

    const workers = await loadNestedKeys(`fw_psy_loctr/${dayKey}/${batchSelect.value}`);
    populateSelect(fieldWorkerSelect, workers, "Select Field Worker");

    updateSubmitButtonState();
  };

  const updateBatches = async (dayKey) => {
    resetVillages();
    updateSubmitButtonState();

    if (!dayKey) {
      return;
    }

    const batches = await loadNestedKeys(`fw_psy_loctr/${dayKey}`);
    populateSelect(batchSelect, batches, "Select Village");

    updateSubmitButtonState();
  };

  const days = await loadNestedKeys("fw_psy_loctr");

  populateSelect(daySelect, days, "Select Panchayat");
  resetVillages();

  updateSubmitButtonState();

  daySelect.addEventListener("change", async (event) => {
    const dayKey = event.target.value;

    clearMapOverlays();
    setNoDataMessage("");
    await updateBatches(dayKey);
    updateSubmitButtonState();
  });

  batchSelect.addEventListener("change", async (event) => {
    clearMapOverlays();
    setNoDataMessage("");
    await updateWorkers(daySelect.value);
    updateSubmitButtonState();
  });

  fieldWorkerSelect.addEventListener("change", async (event) => {
    clearMapOverlays();
    setNoDataMessage("");
    updateSubmitButtonState();
  });

  submitButton.addEventListener("click", async () => {
    if (daySelect.value && batchSelect.value && fieldWorkerSelect.value) {
      await drawPath(daySelect.value, batchSelect.value, fieldWorkerSelect.value, "__all__");
    }
  });
}

async function drawPath(dayKey, batchKey, uuid, selectedTimestamp = "__all__") {
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

  clearMapOverlays();

  const snapshot = await db.ref(`fw_psy_loctr/${dayKey}/${batchKey}/${uuid}`).once("value");
  const workerData = snapshot.val() || {};
  const timestampTracks = buildTimestampTracks(workerData, uuid, selectedTimestamp);
  const path = timestampTracks.flatMap((track) => track.path).sort((left, right) => left.timestamp - right.timestamp);

  if (!timestampTracks.length || !path.length) {
    setNoDataMessage(`No GPS points found for ${uuid} in ${batchKey}.`);
    map.setCenter({
      lat: 12.972442,
      lng: 77.580643,
    });
    map.setZoom(15);
    return;
  }

  if (!infoWindow) {
    infoWindow = new google.maps.InfoWindow();
  }

  timestampTracks.forEach(({ timestampKey, path: currentPath }, index) => {
    const strokeColor = mapColors[index % mapColors.length];
    const polyline = new google.maps.Polyline({
      path: currentPath.map((point) => ({
        lat: point.lat,
        lng: point.lng,
      })),
      geodesic: true,
      strokeColor,
      strokeOpacity: 1,
      strokeWeight: 5,
    });

    polyline.setMap(map);

    polyline.addListener("mousemove", (event) => {
      const previousPoint = findPreviousPointForHover(currentPath, event.latLng);

      if (!previousPoint) {
        return;
      }

      infoWindow.setContent(`${formatTimestamp(previousPoint.timestamp, previousPoint.uuid)}<br><b>Timestamp Group</b><br>${formatTimestampOption(timestampKey)}`);
      infoWindow.setPosition(event.latLng);
      infoWindow.open({
        map,
      });
    });

    polyline.addListener("mouseout", () => {
      infoWindow.close();
    });

    polylines.push(polyline);

    startMarkers.push(createTrackMarker(currentPath[0], "S", strokeColor, `Start: ${formatTimestampOption(timestampKey)}`));
    endMarkers.push(createTrackMarker(currentPath[currentPath.length - 1], "E", strokeColor, `End: ${formatTimestampOption(timestampKey)}`));
  });

  const bounds = new google.maps.LatLngBounds();

  path.forEach((point) => bounds.extend(point));

  map.fitBounds(bounds);
}

loadFieldWorkers();

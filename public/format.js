const timeFormat = new Intl.DateTimeFormat("ru", {
  hour: "2-digit",
  minute: "2-digit",
});
const dayFormat = new Intl.DateTimeFormat("ru", {
  day: "numeric",
  month: "long",
});
const dayWithYearFormat = new Intl.DateTimeFormat("ru", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

function startOfDay(timestamp) {
  return new Date(timestamp).setHours(0, 0, 0, 0);
}

function daysAgo(timestamp) {
  return Math.round(
    (startOfDay(Date.now()) - startOfDay(timestamp)) / 86400000,
  );
}

export function formatTime(timestamp) {
  return timeFormat.format(timestamp);
}

export function formatDay(timestamp) {
  const age = daysAgo(timestamp);
  if (age === 0) {
    return "Сегодня";
  }
  if (age === 1) {
    return "Вчера";
  }
  const isThisYear =
    new Date(timestamp).getFullYear() === new Date().getFullYear();
  return (isThisYear ? dayFormat : dayWithYearFormat).format(timestamp);
}

export function formatChatTime(timestamp) {
  return daysAgo(timestamp) === 0
    ? formatTime(timestamp)
    : formatDay(timestamp);
}

export function isSameDay(firstTimestamp, secondTimestamp) {
  return startOfDay(firstTimestamp) === startOfDay(secondTimestamp);
}

export function formatFileSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} Б`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.ceil(bytes / 1024)} КБ`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} МБ`;
}

export function formatUserId(id) {
  return id.match(/.{1,4}/g).join("-");
}

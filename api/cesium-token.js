export default function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).end();
  }

  const token = process.env.cesium_ion_token;

  if (!token) {
    return res.status(500).json({
      error: "Cesium ion token is not configured"
    });
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ token });
}

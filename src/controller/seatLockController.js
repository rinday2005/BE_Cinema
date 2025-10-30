import mongoose from "mongoose";
import SeatLock from "../model/SeatLock.js";
import Showtime from "../model/Showtime.js";
import Booking from "../model/Booking.js";
import Cinema from "../model/Cinema.js";
import CinemaSystem from "../model/CinemaSystem.js";
import Combo from "../model/Combo.js";

// =======================================================
// ✅ GIỮ GHẾ (LOCK SEATS)
// =======================================================
export const lockSeats = async (req, res) => {
  try {
    const { showtimeId, seatNumbers, userId, userEmail } = req.body;

    // --- Kiểm tra dữ liệu đầu vào
    if (
      !showtimeId ||
      !Array.isArray(seatNumbers) ||
      seatNumbers.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Thiếu thông tin suất chiếu hoặc danh sách ghế.",
      });
    }

    if (!userId || !userEmail) {
      return res.status(400).json({
        success: false,
        message: "Thiếu thông tin người dùng.",
      });
    }

    // --- Kiểm tra suất chiếu tồn tại
    const showtime = await Showtime.findById(showtimeId);
    if (!showtime) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy suất chiếu.",
      });
    }

    // Dùng đúng field seats theo schema
    const seatData = Array.isArray(showtime.seats) ? showtime.seats : [];

    // --- Xác định ghế đã bị chiếm hoặc bán
    const occupiedSeats = new Set(
      seatData
        .filter(
          (s) =>
            s &&
            seatNumbers.includes(s.seatNumber) &&
            ["occupied", "sold", "reserved"].includes(s.status)
        )
        .map((s) => s.seatNumber)
    );

    // --- Lấy danh sách ghế đang bị giữ (lock)
    const activeLocks = await SeatLock.find({
      showtimeId,
      isActive: true,
      expiresAt: { $gt: new Date() },
      seatNumbers: { $in: seatNumbers },
    }).lean();

    const lockedSeats = new Set();
    for (const lock of activeLocks) {
      for (const sn of lock.seatNumbers) {
        if (seatNumbers.includes(sn)) lockedSeats.add(sn);
      }
    }

    // --- Nếu có ghế bị chiếm hoặc lock thì trả về lỗi
    const conflictingSeats = Array.from(
      new Set([...occupiedSeats, ...lockedSeats])
    );
    if (conflictingSeats.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Một số ghế đã được giữ hoặc đặt.",
        conflictingSeats,
      });
    }

    // --- Hủy các lock cũ đã hết hạn của user
    await SeatLock.updateMany(
      { userId, showtimeId, isActive: true, expiresAt: { $lt: new Date() } },
      { $set: { isActive: false } }
    );

    // --- Tạo mới lock
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 phút
    const seatLock = await SeatLock.create({
      showtimeId,
      seatNumbers,
      userId,
      userEmail,
      expiresAt,
      isActive: true,
    });

    return res.status(200).json({
      success: true,
      message: "Đã giữ ghế thành công.",
      lockId: seatLock._id,
      expiresAt,
      expiresIn: Math.floor((expiresAt - new Date()) / 1000),
    });
  } catch (error) {
    console.error("❌ lockSeats error:", error);
    res.status(500).json({
      success: false,
      message: "Lỗi server khi giữ ghế.",
      error: error.message,
    });
  }
};

// =======================================================
// ✅ LẤY DANH SÁCH GHẾ ĐANG BỊ GIỮ
// =======================================================
export const getLockedSeats = async (req, res) => {
  try {
    const { showtimeId } = req.params;

    if (!showtimeId) {
      return res
        .status(400)
        .json({ success: false, message: "Thiếu showtimeId." });
    }

    const lockedSeats = await SeatLock.find({
      showtimeId,
      isActive: true,
      expiresAt: { $gt: new Date() },
    }).select("seatNumbers userId userEmail expiresAt");

    // Gộp toàn bộ ghế bị giữ thành 1 mảng
    const allLockedSeats = lockedSeats.flatMap((lock) =>
      lock.seatNumbers.map((seatNumber) => ({
        seatNumber,
        lockedBy: lock.userId,
        lockedByEmail: lock.userEmail,
        expiresAt: lock.expiresAt,
      }))
    );

    return res.status(200).json({
      success: true,
      lockedSeats: allLockedSeats,
    });
  } catch (error) {
    console.error("❌ getLockedSeats error:", error);
    res.status(500).json({
      success: false,
      message: "Lỗi server khi lấy ghế bị giữ.",
      error: error.message,
    });
  }
};

// =======================================================
// ✅ HỦY GIỮ GHẾ (UNLOCK SEATS)
// =======================================================
export const unlockSeats = async (req, res) => {
  try {
    const { lockId, userId } = req.body;

    if (!lockId || !userId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu thông tin lockId hoặc userId.",
      });
    }

    const result = await SeatLock.updateOne(
      { _id: lockId, userId, isActive: true },
      { $set: { isActive: false } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy lock hoặc bạn không có quyền hủy.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Đã hủy giữ ghế thành công.",
    });
  } catch (error) {
    console.error("❌ unlockSeats error:", error);
    res.status(500).json({
      success: false,
      message: "Lỗi server khi hủy giữ ghế.",
      error: error.message,
    });
  }
};

// =======================================================
// ✅ XÁC NHẬN ĐẶT VÉ (CONFIRM BOOKING) — FIX COMBO DETAIL
// =======================================================
export const confirmBooking = async (req, res) => {
  try {
    const { lockId, userId, bookingData } = req.body;

    if (!lockId || !userId || !bookingData) {
      return res.status(400).json({
        success: false,
        message: "Thiếu lockId, userId hoặc bookingData.",
      });
    }

    const seatLock = await SeatLock.findById(lockId);
    if (!seatLock) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy lockId.",
      });
    }

    if (!seatLock.isActive) {
      return res.status(400).json({
        success: false,
        message: "Lock đã hết hạn hoặc không còn hiệu lực.",
      });
    }

    // 🟢 Lấy thông tin combo chi tiết từ DB
    const comboDetails = [];
    if (
      Array.isArray(bookingData.selectedCombos) &&
      bookingData.selectedCombos.length > 0
    ) {
      for (const comboItem of bookingData.selectedCombos) {
        const combo = await Combo.findById(
          comboItem._id || comboItem.id
        ).lean();
        if (combo) {
          comboDetails.push({
            comboId: combo._id,
            name: combo.name,
            price: combo.price,
            quantity: comboItem.quantity || 1,
            totalPrice: combo.price * (comboItem.quantity || 1),
          });
        }
      }
    }

    // 🟢 Tính tổng combo (nếu có)
    const totalComboPrice = comboDetails.reduce(
      (sum, c) => sum + c.totalPrice,
      0
    );

    // 🟢 Tổng tiền cuối cùng (bao gồm combo + vé)
    const grandTotal = bookingData.total + totalComboPrice;

    // ✅ Tạo booking
    const newBooking = new Booking({
      userId,
      showtimeId: seatLock.showtimeId,
      userEmail: bookingData.userEmail,
      movieTitle: bookingData.movieTitle,
      moviePoster: bookingData.moviePoster,

      cinemaInfo: {
        systemName: bookingData.systemName || "Hệ thống rạp",
        clusterName: bookingData.clusterName || "Cụm rạp",
        hallName: bookingData.hallName || "Phòng chiếu",
        systemId: bookingData.systemId,
        clusterId: bookingData.clusterId,
        hallId: bookingData.hallId,
      },

      showtimeInfo: {
        date: bookingData.date,
        startTime: bookingData.startTime,
        endTime: bookingData.endTime,
      },

      seats: bookingData.selectedSeats,
      combos: comboDetails, // ✅ Lưu combo chi tiết
      total: grandTotal, // ✅ Gồm cả tiền combo

      paymentMethod: bookingData.paymentMethod,
      paymentStatus: "paid",
      bookingStatus: "confirmed",
      bookingCode: `BK${Date.now()}`,
      qrCode: `QR-${Date.now()}`,
    });

    await newBooking.save();

    // ✅ Cập nhật trạng thái ghế trong Showtime thành "locked" (giống hành vi quay lại Payment)
    const showtime = await Showtime.findById(seatLock.showtimeId);
    if (showtime) {
      const seatsArray = Array.isArray(showtime.seats) ? showtime.seats : [];
      showtime.seats = seatsArray.map((seat) => {
        if (seatLock.seatNumbers.includes(seat.seatNumber)) {
          seat.status = "locked";
        }
        return seat;
      });
      // Không trừ availableSeats khi chỉ giữ ghế
      await showtime.save();
    }

    // ✅ Gia hạn khóa ghế sau khi thanh toán thành công (để tiếp tục bị khóa)
    seatLock.isActive = true;
    seatLock.status = "confirmed";
    seatLock.expiresAt = new Date(Date.now() + 10 * 60 * 1000); // +10 phút
    await seatLock.save();

    return res.status(200).json({
      success: true,
      message: "Xác nhận đặt vé thành công.",
      booking: newBooking,
    });
  } catch (error) {
    console.error("❌ confirmBooking error:", error);
    res.status(500).json({
      success: false,
      message: "Lỗi server khi xác nhận đặt vé.",
      error: error.message,
    });
  }
};

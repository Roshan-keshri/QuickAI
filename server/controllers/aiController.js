import OpenAI from "openai";
import sql from "../configs/db.js";
import { clerkClient } from "@clerk/express";
import {v2 as cloudinary} from 'cloudinary';
import fs from 'fs'
import pdf from 'pdf-parse/lib/pdf-parse.js';
import FormData from "form-data";
import axios from "axios";

const AI = new OpenAI({ 
    apiKey: process.env.GEMINI_API_KEY, // Corrected: removed quotes
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
});

export const generateArticle = async (req, res) => {
    try {
        const { userId } = await req.auth(); // Corrected: req.auth is an object
        const { prompt, length } = req.body;
        const plan = req.plan;
        const free_usage = req.free_usage;

        // if (plan !== 'premium' && free_usage >= 10) {
        //     return res.status(403).json({ success: false, message: "Limit reached. Upgrade to continue." });
        // }

        const response = await AI.chat.completions.create({
            model: "gemini-1.5-flash", // Corrected: model name
            messages: [{
                role: "user",
                content: prompt,
            }],
            temperature: 0.7,
            max_tokens: length,
        });

        const content = response.choices[0].message.content;

        await sql`INSERT INTO creations(user_id, prompt, content, type)
            VALUES (${userId}, ${prompt}, ${content}, 'article')`;

        if (plan !== 'premium') {
            await clerkClient.users.updateUserMetadata(userId, {
                privateMetadata: {
                    free_usage: free_usage + 1
                }
            });
        }

        res.status(200).json({ success: true, content });

    } catch (error) {
        console.error("AI Controller Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};


export const generateBlogTitle = async (req, res) => {
    try {
        const { userId } = await req.auth(); // Corrected: req.auth is an object
        const { prompt } = req.body;
        const plan = req.plan;
        const free_usage = req.free_usage;

        // if (plan !== 'premium' && free_usage >= 10) {
        //     return res.status(403).json({ success: false, message: "Limit reached. Upgrade to continue." });
        // }

        const response = await AI.chat.completions.create({
            model: "gemini-1.5-flash", // Corrected: model name
            messages: [{
                role: "user",
                content: prompt,
            }],
            temperature: 0.7,
            max_tokens:100,
        });

        const content = response.choices[0].message.content;

        await sql`INSERT INTO creations(user_id, prompt, content, type)
            VALUES (${userId}, ${prompt}, ${content}, 'blog-title')`;

        if (plan !== 'premium') {
            await clerkClient.users.updateUserMetadata(userId, {
                privateMetadata: {
                    free_usage: free_usage + 1
                }
            });
        }

        res.status(200).json({ success: true, content });

    } catch (error) {
        console.error("AI Controller Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};


export const generateImage = async (req, res) => {
    try {
        const { userId } = await req.auth(); // Corrected: req.auth is an object
        const { prompt,publish } = req.body;
        const plan = req.plan;

        // if (plan !== 'premium') {
        //     return res.status(403).json({ success: false, message: "This feature is only available for premium subcriptions" });
        // }

        const formData = new FormData()
        formData.append('prompt', prompt);
        const {data} =await axios.post("https://clipdrop-api.co/text-to-image/v1",formData,{
          headers  :{ 'x-api-key': process.env.CLIPDROP_API_KEY,},
          responseType:"arraybuffer",
        })

        const base64Image=`data:image/png;base64,${Buffer.from(data,'binary').toString('base64')}`;

        const {secure_url}=await cloudinary.uploader.upload(base64Image)

        await sql`INSERT INTO creations(user_id, prompt, content, type,publish)
            VALUES (${userId}, ${prompt}, ${secure_url}, 'image',${publish??false})`;


        res.status(200).json({ success: true, content:secure_url });

    } catch (error) {
        console.error("AI Controller Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

export const removeImageBackground = async (req, res) => {
  try {
    const { userId } = await req.auth();
    const plan = req.plan || "free";

    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    const imagePath = req.file.path;

    // If you want premium-only:
    // if (plan !== "premium") {
    //   fs.unlinkSync(imagePath);
    //   return res.status(403).json({ success: false, message: "This feature is for premium users only" });
    // }

    // Upload to Cloudinary with background removal
    const uploadResult = await cloudinary.uploader.upload(imagePath, {
      folder: "background_removed",
      transformation: [
        {
          effect: "background_removal",
        },
      ],
    });

    // Delete local temp file
    fs.unlinkSync(imagePath);

    // Save to DB
    await sql`
      INSERT INTO creations(user_id, prompt, content, type, publish)
      VALUES (${userId}, 'Remove background from image', ${uploadResult.secure_url}, 'image', false)
    `;

    res.status(200).json({ success: true, content: uploadResult.secure_url });

  } catch (error) {
    console.error("Cloudinary Remove BG Error:", error.message || error);
    res.status(500).json({
      success: false,
      message: error.message || "Something went wrong while removing background",
    });
  }
};

export const removeImageObject = async (req, res) => {
  try {
    // 1. Get userId from Clerk
    const { userId } = await req.auth();
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized: No user ID found' });
    }

    // 2. Validate required inputs
    const { object } = req.body;
    if (!object || object.trim() === '') {
      return res.status(400).json({ success: false, message: 'No object specified for removal' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image uploaded' });
    }

    const image = req.file;

    // 3. Optional: Check subscription plan
    // if (req.plan !== 'premium') {
    //   return res.status(403).json({ success: false, message: "This feature is only available for premium subscriptions" });
    // }

    // 4. Upload to Cloudinary
    let uploadResult;
    try {
      uploadResult = await cloudinary.uploader.upload(image.path);
    } catch (err) {
      console.error("Cloudinary Upload Error:", err);
      return res.status(500).json({ success: false, message: 'Cloudinary upload failed', error: err.message });
    }

    // 5. Apply AI object removal transformation
    let imageUrl;
    try {
      imageUrl = cloudinary.url(uploadResult.public_id, {
        transformation: [{ effect: `gen_remove:${object}` }],
        resource_type: 'image'
      });
    } catch (err) {
      console.error("Cloudinary Transformation Error:", err);
      return res.status(500).json({ success: false, message: 'Cloudinary transformation failed', error: err.message });
    }

    // 6. Insert into database
    try {
      await sql`
        INSERT INTO creations(user_id, prompt, content, type, publish)
        VALUES (${userId}, ${`Remove ${object} from image`}, ${imageUrl}, 'image', false)
      `;
    } catch (err) {
      console.error("Database Error:", err);
      return res.status(500).json({ success: false, message: 'Database insert failed', error: err.message });
    }

    // 7. Success
    res.status(200).json({ success: true, content: imageUrl });

  } catch (error) {
    console.error("AI Controller Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const resumeReview = async (req, res) => {
    try {
        const { userId } = await req.auth(); // Corrected: req.auth is an object
        const resume= req.file;
        const plan = req.plan;

        if (plan !== 'premium') {
            return res.status(403).json({ success: false, message: "This feature is only available for premium subcriptions" });
        }

         if(resume.size > 5*1024*1024){
            return res.json({success:false,message:"Resume file size exceeds allowed size (5MB)"})
         }

         const dataBuffer = fs.readFileSync(resume.path)
         const pdfData = await pdf(dataBuffer)

         const prompt = `Review the folowing resume and provide constructive feedback on its strengths, weaknesses, and areas for improvement. Resume content:\n\n ${pdfData.text}`;
        
         const response = await AI.chat.completions.create({
            model: "gemini-1.5-flash", // Corrected: model name
            messages: [{
                role: "user",
                content: prompt,
            }],
            temperature: 0.7,
            max_tokens:1000,
        });

        const content = response.choices[0].message.content; 
        

        await sql`INSERT INTO creations(user_id, prompt, content, type,publish)
            VALUES (${userId},'Review the uploaded resume', ${content}, 'resume-review')`;


        res.status(200).json({ success: true, content});

    } catch (error) {
        console.error("AI Controller Error:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};